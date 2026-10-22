package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"strings"

	"messenger/internal/i18n"
	"messenger/internal/models"
	"messenger/internal/repositories"
	"messenger/internal/storage"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

const (
	maxGroupNameLength = 100
	maxGroupMembers    = 50
	unknownActorName   = i18n.SomeoneName
)

// GroupService handles business logic for group chats.
type GroupService struct {
	db              *gorm.DB
	logger          *zap.Logger
	chatRepo        *repositories.ChatRepo
	participantRepo *repositories.ChatParticipantRepo
	messageRepo     *repositories.MessageRepo
	unreadRepo      *repositories.UnreadMessageRepo
	userRepo        *repositories.UserRepo
	fileStorage     storage.Storage
	validator       *fileValidator
}

// NewGroupService creates a new GroupService.
func NewGroupService(
	db *gorm.DB,
	logger *zap.Logger,
	chatRepo *repositories.ChatRepo,
	participantRepo *repositories.ChatParticipantRepo,
	messageRepo *repositories.MessageRepo,
	unreadRepo *repositories.UnreadMessageRepo,
	userRepo *repositories.UserRepo,
	fileStorage storage.Storage,
) *GroupService {
	return &GroupService{
		db:              db,
		logger:          logger,
		chatRepo:        chatRepo,
		participantRepo: participantRepo,
		messageRepo:     messageRepo,
		unreadRepo:      unreadRepo,
		userRepo:        userRepo,
		fileStorage:     fileStorage,
		validator:       &fileValidator{},
	}
}

// CreateGroup creates a new group chat with the given members.
func (s *GroupService) CreateGroup(ctx context.Context, creatorID uint, name string, memberIDs []uint) (*models.Chat, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > maxGroupNameLength {
		return nil, fmt.Errorf("group name must be 1-%d characters", maxGroupNameLength)
	}

	cleanMemberIDs := deduplicateIDs(memberIDs, creatorID)
	if len(cleanMemberIDs) == 0 {
		return nil, errors.New("group must have at least one member besides the creator")
	}
	if len(cleanMemberIDs)+1 > maxGroupMembers {
		return nil, fmt.Errorf("group cannot have more than %d members", maxGroupMembers)
	}

	creator, err := s.userRepo.FindByID(ctx, creatorID)
	if err != nil {
		return nil, errors.New("creator not found")
	}

	var chat *models.Chat
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		chat, err = s.createGroupInTx(ctx, tx, creatorID, name, cleanMemberIDs, creator)
		return err
	})
	if err != nil {
		return nil, err
	}
	return chat, nil
}

// createGroupInTx performs the transactional part of group creation.
func (s *GroupService) createGroupInTx(ctx context.Context, tx *gorm.DB, creatorID uint, name string, memberIDs []uint, creator *models.User) (*models.Chat, error) {
	chatRepo := s.chatRepo.WithTx(tx)
	participantRepo := s.participantRepo.WithTx(tx)
	messageRepo := s.messageRepo.WithTx(tx)

	chat := &models.Chat{
		IsGroup:   true,
		GroupName: &name,
		CreatorID: &creatorID,
	}
	if err := chatRepo.Create(ctx, chat); err != nil {
		return nil, fmt.Errorf("create group chat: %w", err)
	}

	if err := participantRepo.Create(ctx, &models.ChatParticipant{
		ChatID: chat.ID,
		UserID: creatorID,
		Role:   models.RoleCreator,
	}); err != nil {
		return nil, fmt.Errorf("add creator: %w", err)
	}

	for _, memberID := range memberIDs {
		if err := participantRepo.Create(ctx, &models.ChatParticipant{
			ChatID: chat.ID,
			UserID: memberID,
			Role:   models.RoleMember,
		}); err != nil {
			return nil, fmt.Errorf("add member %d: %w", memberID, err)
		}
	}

	sysText := i18n.GroupCreated(creator.GetDisplayName())
	if err := createSystemMessage(ctx, messageRepo, chat.ID, sysText); err != nil {
		return nil, err
	}
	return chat, nil
}

// DeleteGroup deletes a group and all its data. Creator only.
func (s *GroupService) DeleteGroup(ctx context.Context, chatID, userID uint) error {
	if err := s.requireRole(ctx, chatID, userID, models.RoleCreator); err != nil {
		return err
	}

	// Collect S3 keys before the transaction deletes DB records.
	storageKeys, avatarKey, err := s.collectGroupStorageKeys(ctx, chatID)
	if err != nil {
		return err
	}

	if err := s.purgeGroupData(ctx, chatID); err != nil {
		return err
	}

	// Best-effort S3 cleanup after successful transaction.
	s.deleteStorageFiles(storageKeys, avatarKey)
	return nil
}

// collectGroupStorageKeys gathers all S3 keys (attachments + avatar) for a group before deletion.
func (s *GroupService) collectGroupStorageKeys(ctx context.Context, chatID uint) ([]string, string, error) {
	var storageKeys []string
	if err := s.db.WithContext(ctx).Model(&models.Attachment{}).
		Where("message_id IN (SELECT id FROM messages WHERE chat_id = ?)", chatID).
		Pluck("storage_key", &storageKeys).Error; err != nil {
		return nil, "", fmt.Errorf("fetch attachment keys: %w", err)
	}

	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return nil, "", errors.New("group not found")
	}

	var avatarKey string
	if chat.AvatarURL != nil && *chat.AvatarURL != "" {
		avatarKey = *chat.AvatarURL
	}

	return storageKeys, avatarKey, nil
}

// purgeGroupData hard-deletes all group data (participants, pins, unreads, attachments, messages, chat) in a transaction.
func (s *GroupService) purgeGroupData(ctx context.Context, chatID uint) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Unscoped().Where("chat_id = ?", chatID).Delete(&models.ChatParticipant{}).Error; err != nil {
			return fmt.Errorf("delete participants: %w", err)
		}
		if err := tx.Unscoped().Where("chat_id = ?", chatID).Delete(&models.PinnedMessage{}).Error; err != nil {
			return fmt.Errorf("delete pinned messages: %w", err)
		}
		if err := tx.Unscoped().Where("chat_id = ?", chatID).Delete(&models.UnreadMessage{}).Error; err != nil {
			return fmt.Errorf("delete unread messages: %w", err)
		}
		if err := tx.Unscoped().Where("message_id IN (SELECT id FROM messages WHERE chat_id = ?)", chatID).Delete(&models.Attachment{}).Error; err != nil {
			return fmt.Errorf("delete attachments: %w", err)
		}
		if err := tx.Model(&models.Message{}).Where("chat_id = ? AND reply_to_id IS NOT NULL", chatID).Update("reply_to_id", nil).Error; err != nil {
			return fmt.Errorf("clear reply refs: %w", err)
		}
		if err := tx.Unscoped().Where("chat_id = ?", chatID).Delete(&models.Message{}).Error; err != nil {
			return fmt.Errorf("delete messages: %w", err)
		}
		if err := tx.Unscoped().Delete(&models.Chat{}, chatID).Error; err != nil {
			return fmt.Errorf("delete chat: %w", err)
		}
		return nil
	})
}

// deleteStorageFiles removes attachment files and optional avatar from S3 (best-effort).
func (s *GroupService) deleteStorageFiles(keys []string, avatarKey string) {
	for _, key := range keys {
		if err := s.fileStorage.Delete(key); err != nil {
			s.logger.Warn("failed to delete attachment from storage", zap.Error(err), zap.String("key", key))
		}
	}
	if avatarKey != "" {
		if err := s.fileStorage.Delete(avatarKey); err != nil {
			s.logger.Warn("failed to delete group avatar from storage", zap.Error(err), zap.String("key", avatarKey))
		}
	}
}

// AddMembers adds members to a group. Admin/creator only.
func (s *GroupService) AddMembers(ctx context.Context, chatID, actorID uint, memberIDs []uint) ([]uint, error) {
	if err := s.requireAdmin(ctx, chatID, actorID); err != nil {
		return nil, err
	}

	actor, err := s.userRepo.FindByID(ctx, actorID)
	if err != nil {
		return nil, errors.New("actor not found")
	}

	currentCount, err := s.participantRepo.CountByChatID(ctx, chatID)
	if err != nil {
		return nil, fmt.Errorf("count members: %w", err)
	}

	cleanIDs := deduplicateIDs(memberIDs, 0)
	if int(currentCount)+len(cleanIDs) > maxGroupMembers {
		return nil, fmt.Errorf("group cannot have more than %d members", maxGroupMembers)
	}

	var addedIDs []uint
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		participantRepo := s.participantRepo.WithTx(tx)
		messageRepo := s.messageRepo.WithTx(tx)

		for _, memberID := range cleanIDs {
			added, addErr := s.addOrRestoreMember(ctx, tx, participantRepo, chatID, memberID)
			if addErr != nil {
				return addErr
			}
			if !added {
				continue
			}
			addedIDs = append(addedIDs, memberID)
			s.createMemberAddedMessage(ctx, messageRepo, chatID, memberID, actor)
		}

		return tx.Model(&models.Chat{}).Where("id = ?", chatID).
			UpdateColumn("updated_at", gorm.Expr("NOW()")).Error
	})
	if err != nil {
		return nil, err
	}
	return addedIDs, nil
}

// addOrRestoreMember adds a member to the group, restoring a soft-deleted record if one exists.
// Returns true if the member was actually added (false if already active).
func (s *GroupService) addOrRestoreMember(ctx context.Context, tx *gorm.DB, participantRepo *repositories.ChatParticipantRepo, chatID, memberID uint) (bool, error) {
	// Skip if already an active member
	if _, err := participantRepo.FindByUserAndChat(ctx, chatID, memberID); err == nil {
		return false, nil
	}

	// Check for a soft-deleted record (previously removed member)
	var softDeleted models.ChatParticipant
	err := tx.WithContext(ctx).Unscoped().
		Where("chat_id = ? AND user_id = ? AND deleted_at IS NOT NULL", chatID, memberID).
		First(&softDeleted).Error

	if err == nil {
		// Restore the soft-deleted record
		restoreErr := tx.WithContext(ctx).Unscoped().
			Model(&softDeleted).
			Updates(map[string]any{"deleted_at": nil, "role": models.RoleMember}).Error
		if restoreErr != nil {
			return false, fmt.Errorf("restore member %d: %w", memberID, restoreErr)
		}
		return true, nil
	}

	// Create a new participant
	if err := participantRepo.Create(ctx, &models.ChatParticipant{
		ChatID: chatID,
		UserID: memberID,
		Role:   models.RoleMember,
	}); err != nil {
		return false, fmt.Errorf("add member %d: %w", memberID, err)
	}
	return true, nil
}

// createMemberAddedMessage creates a system message for a newly added member.
func (s *GroupService) createMemberAddedMessage(ctx context.Context, messageRepo *repositories.MessageRepo, chatID, memberID uint, actor *models.User) {
	member, err := s.userRepo.FindByID(ctx, memberID)
	if err != nil {
		s.logger.Warn("failed to find member for system message", zap.Uint("member_id", memberID), zap.Error(err))
		return
	}
	sysText := i18n.MemberAdded(member.GetDisplayName(), actor.GetDisplayName())
	if err := createSystemMessage(ctx, messageRepo, chatID, sysText); err != nil {
		s.logger.Warn("failed to create member added system message", zap.Error(err))
	}
}

// RemoveMember removes a member from the group. Admin/creator only. Cannot remove creator.
func (s *GroupService) RemoveMember(ctx context.Context, chatID, actorID, targetUserID uint) error {
	if err := s.requireAdmin(ctx, chatID, actorID); err != nil {
		return err
	}

	// Cannot remove creator
	targetParticipant, err := s.participantRepo.FindByUserAndChat(ctx, chatID, targetUserID)
	if err != nil {
		return errors.New("user is not a member of this group")
	}
	if targetParticipant.IsCreator() {
		return errors.New("cannot remove group creator")
	}

	// An admin cannot remove another admin (only creator can)
	if targetParticipant.Role == models.RoleAdmin {
		actorParticipant, err := s.participantRepo.FindByUserAndChat(ctx, chatID, actorID)
		if err != nil {
			return errors.New("actor not found")
		}
		if !actorParticipant.IsCreator() {
			return errors.New("only the creator can remove admins")
		}
	}

	actor, actorErr := s.userRepo.FindByID(ctx, actorID)
	if actorErr != nil {
		s.logger.Warn("failed to find actor for system message", zap.Uint("actor_id", actorID), zap.Error(actorErr))
	}
	target, targetErr := s.userRepo.FindByID(ctx, targetUserID)
	if targetErr != nil {
		s.logger.Warn("failed to find target for system message", zap.Uint("user_id", targetUserID), zap.Error(targetErr))
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		participantRepo := s.participantRepo.WithTx(tx)
		messageRepo := s.messageRepo.WithTx(tx)

		if err := participantRepo.Delete(ctx, chatID, targetUserID); err != nil {
			return fmt.Errorf("remove member: %w", err)
		}

		// Delete unread messages for removed user
		if err := tx.Where("chat_id = ? AND user_id = ?", chatID, targetUserID).
			Delete(&models.UnreadMessage{}).Error; err != nil {
			s.logger.Warn("failed to clean unread for removed user", zap.Error(err))
		}

		actorName := unknownActorName
		if actor != nil {
			actorName = actor.GetDisplayName()
		}
		targetName := i18n.UnknownUserLower
		if target != nil {
			targetName = target.GetDisplayName()
		}
		sysText := i18n.MemberRemoved(targetName, actorName)
		return createSystemMessage(ctx, messageRepo, chatID, sysText)
	})
}

// LeaveGroup allows a member to leave the group. Creator cannot leave.
func (s *GroupService) LeaveGroup(ctx context.Context, chatID, userID uint) error {
	participant, err := s.participantRepo.FindByUserAndChat(ctx, chatID, userID)
	if err != nil {
		return errors.New("user is not a member of this group")
	}
	if participant.IsCreator() {
		return errors.New("creator cannot leave the group; delete it instead")
	}

	user, userErr := s.userRepo.FindByID(ctx, userID)
	if userErr != nil {
		s.logger.Warn("failed to find user for system message", zap.Uint("user_id", userID), zap.Error(userErr))
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		participantRepo := s.participantRepo.WithTx(tx)
		messageRepo := s.messageRepo.WithTx(tx)

		if err := participantRepo.Delete(ctx, chatID, userID); err != nil {
			return fmt.Errorf("leave group: %w", err)
		}

		// Delete unread messages for leaving user
		if err := tx.Where("chat_id = ? AND user_id = ?", chatID, userID).
			Delete(&models.UnreadMessage{}).Error; err != nil {
			s.logger.Warn("failed to clean unread for leaving user", zap.Error(err))
		}

		userName := i18n.UnknownUser
		if user != nil {
			userName = user.GetDisplayName()
		}
		sysText := i18n.MemberLeft(userName)
		return createSystemMessage(ctx, messageRepo, chatID, sysText)
	})
}

// ChangeRole changes a member's role. Creator only.
func (s *GroupService) ChangeRole(ctx context.Context, chatID, actorID, targetUserID uint, newRole models.ParticipantRole) error {
	if err := s.requireRole(ctx, chatID, actorID, models.RoleCreator); err != nil {
		return errors.New("only the creator can change roles")
	}

	if newRole == models.RoleCreator {
		return errors.New("cannot assign creator role")
	}
	if newRole != models.RoleAdmin && newRole != models.RoleMember {
		return errors.New("invalid role")
	}

	targetParticipant, err := s.participantRepo.FindByUserAndChat(ctx, chatID, targetUserID)
	if err != nil {
		return errors.New("user is not a member of this group")
	}
	if targetParticipant.IsCreator() {
		return errors.New("cannot change creator's role")
	}

	if targetParticipant.Role == newRole {
		return nil // no change needed
	}

	actor, actorErr := s.userRepo.FindByID(ctx, actorID)
	if actorErr != nil {
		s.logger.Warn("failed to find actor for system message", zap.Uint("actor_id", actorID), zap.Error(actorErr))
	}
	target, targetErr := s.userRepo.FindByID(ctx, targetUserID)
	if targetErr != nil {
		s.logger.Warn("failed to find target for system message", zap.Uint("user_id", targetUserID), zap.Error(targetErr))
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		participantRepo := s.participantRepo.WithTx(tx)
		messageRepo := s.messageRepo.WithTx(tx)

		if err := participantRepo.UpdateRole(ctx, chatID, targetUserID, newRole); err != nil {
			return fmt.Errorf("update role: %w", err)
		}

		actorName := unknownActorName
		if actor != nil {
			actorName = actor.GetDisplayName()
		}
		targetName := i18n.UnknownUserLower
		if target != nil {
			targetName = target.GetDisplayName()
		}

		var sysText string
		if newRole == models.RoleAdmin {
			sysText = i18n.RolePromoted(targetName, actorName)
		} else {
			sysText = i18n.RoleDemoted(targetName, actorName)
		}
		return createSystemMessage(ctx, messageRepo, chatID, sysText)
	})
}

// UpdateGroupInfo updates the group name. Admin/creator only.
func (s *GroupService) UpdateGroupInfo(ctx context.Context, chatID, actorID uint, name string) error {
	if err := s.requireAdmin(ctx, chatID, actorID); err != nil {
		return err
	}

	name = strings.TrimSpace(name)
	if name == "" || len(name) > maxGroupNameLength {
		return fmt.Errorf("group name must be 1-%d characters", maxGroupNameLength)
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		messageRepo := s.messageRepo.WithTx(tx)

		if err := tx.Model(&models.Chat{}).Where("id = ?", chatID).Update("group_name", name).Error; err != nil {
			return fmt.Errorf("update group name: %w", err)
		}

		actorName := resolveActorName(ctx, s.userRepo, actorID)
		sysText := i18n.GroupRenamed(actorName, name)
		return createSystemMessage(ctx, messageRepo, chatID, sysText)
	})
}

// UploadGroupAvatar uploads a group avatar. Admin/creator only.
func (s *GroupService) UploadGroupAvatar(ctx context.Context, chatID, actorID uint, fileHeader *multipart.FileHeader) (string, error) {
	if err := s.requireAdmin(ctx, chatID, actorID); err != nil {
		return "", err
	}

	if err := s.validator.validateAvatar(fileHeader); err != nil {
		return "", fmt.Errorf("invalid avatar file: %w", err)
	}

	file, err := fileHeader.Open()
	if err != nil {
		return "", fmt.Errorf("open file: %w", err)
	}
	defer func() { _ = file.Close() }()

	contentType := fileHeader.Header.Get("Content-Type")

	// Get current avatar for cleanup
	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return "", errors.New("group not found")
	}

	var oldKey string
	if chat.AvatarURL != nil && *chat.AvatarURL != "" {
		oldKey = *chat.AvatarURL
	}

	metadata, err := s.fileStorage.Save(file, "group_avatar_"+fileHeader.Filename, contentType, fileHeader.Size)
	if err != nil {
		return "", fmt.Errorf("save avatar: %w", err)
	}

	avatarKey := metadata.Key
	if err := s.db.WithContext(ctx).Model(&models.Chat{}).Where("id = ?", chatID).Update("avatar_url", avatarKey).Error; err != nil {
		if delErr := s.fileStorage.Delete(metadata.Key); delErr != nil {
			s.logger.Warn("failed to rollback group avatar upload", zap.Error(delErr))
		}
		return "", fmt.Errorf("update group avatar: %w", err)
	}

	if oldKey != "" {
		if err := s.fileStorage.Delete(oldKey); err != nil {
			s.logger.Warn("failed to delete old group avatar", zap.Error(err))
		}
	}

	return s.fileStorage.GetURL(avatarKey), nil
}

// DeleteGroupAvatar removes the group avatar. Admin/creator only.
func (s *GroupService) DeleteGroupAvatar(ctx context.Context, chatID, actorID uint) error {
	if err := s.requireAdmin(ctx, chatID, actorID); err != nil {
		return err
	}

	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return errors.New("group not found")
	}
	if chat.AvatarURL == nil || *chat.AvatarURL == "" {
		return errors.New("group has no avatar")
	}

	if err := s.fileStorage.Delete(*chat.AvatarURL); err != nil {
		s.logger.Warn("failed to delete group avatar from storage", zap.Error(err))
	}

	return s.db.WithContext(ctx).Model(&models.Chat{}).Where("id = ?", chatID).Update("avatar_url", nil).Error
}

// GetGroupAvatarReader returns a reader for the group avatar.
func (s *GroupService) GetGroupAvatarReader(ctx context.Context, chatID uint) (io.ReadCloser, string, error) {
	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return nil, "", errors.New("group not found")
	}
	if chat.AvatarURL == nil || *chat.AvatarURL == "" {
		return nil, "", errors.New("group has no avatar")
	}

	reader, err := s.fileStorage.Get(*chat.AvatarURL)
	if err != nil {
		return nil, "", fmt.Errorf("get avatar: %w", err)
	}

	contentType := "image/jpeg"
	key := *chat.AvatarURL
	if strings.HasSuffix(strings.ToLower(key), ".png") {
		contentType = "image/png"
	} else if strings.HasSuffix(strings.ToLower(key), ".webp") {
		contentType = "image/webp"
	}

	return reader, contentType, nil
}

// GetGroupMembers returns all participants with user data.
func (s *GroupService) GetGroupMembers(ctx context.Context, chatID uint) ([]models.ChatParticipant, error) {
	return s.participantRepo.GetByChatIDWithUsers(ctx, chatID)
}

// GetGroupInfo returns the chat with participants preloaded.
func (s *GroupService) GetGroupInfo(ctx context.Context, chatID uint) (*models.Chat, error) {
	return s.chatRepo.FindByIDWithParticipants(ctx, chatID)
}

// IsUserInGroup checks if a user is a member of a group.
func (s *GroupService) IsUserInGroup(ctx context.Context, chatID, userID uint) (bool, error) {
	_, err := s.participantRepo.FindByUserAndChat(ctx, chatID, userID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// GetParticipantUserIDs returns all participant user IDs for a chat.
func (s *GroupService) GetParticipantUserIDs(ctx context.Context, chatID uint) ([]uint, error) {
	return s.participantRepo.GetParticipantUserIDs(ctx, chatID)
}

// GroupParticipantKey carries the X25519 public_key for a single participant.
// Empty PublicKey means the user hasn't completed E2E onboarding yet, in which
// case the calling client must block the group send until every member has a key.
type GroupParticipantKey struct {
	UserID    uint   `json:"user_id"`
	PublicKey string `json:"public_key"`
}

// GetGroupParticipantKeys returns the X25519 public_key of every group member,
// keyed by user_id. Used by clients before composing a scheme=2 group message:
//   - if every key is non-empty, encrypt one envelope per recipient (pairwise);
//   - otherwise the send is blocked so no member is left unable to read.
//
// The caller-authorisation check (only members may read) belongs to the handler.
func (s *GroupService) GetGroupParticipantKeys(ctx context.Context, chatID uint) ([]GroupParticipantKey, error) {
	participants, err := s.participantRepo.GetByChatIDWithUsers(ctx, chatID)
	if err != nil {
		return nil, fmt.Errorf("get participants: %w", err)
	}
	out := make([]GroupParticipantKey, 0, len(participants))
	for _, p := range participants {
		key := ""
		if p.User.PublicKey != nil {
			key = *p.User.PublicKey
		}
		out = append(out, GroupParticipantKey{UserID: p.UserID, PublicKey: key})
	}
	return out, nil
}

// --- private helpers ---

func (s *GroupService) requireAdmin(ctx context.Context, chatID, userID uint) error {
	p, err := s.participantRepo.FindByUserAndChat(ctx, chatID, userID)
	if err != nil {
		return errors.New("user is not a member of this group")
	}
	if !p.IsAdmin() {
		return errors.New("admin or creator role required")
	}
	return nil
}

func (s *GroupService) requireRole(ctx context.Context, chatID, userID uint, role models.ParticipantRole) error {
	p, err := s.participantRepo.FindByUserAndChat(ctx, chatID, userID)
	if err != nil {
		return errors.New("user is not a member of this group")
	}
	if p.Role != role {
		return fmt.Errorf("%s role required", role)
	}
	return nil
}

// createSystemMessage creates a system message (UserID=0) in the given chat.
// Shared between GroupService and PinService for transactional system notifications.
func createSystemMessage(ctx context.Context, messageRepo *repositories.MessageRepo, chatID uint, text string) error {
	msg := &models.Message{
		ChatID: chatID,
		UserID: 0,
		Text:   text,
		Type:   models.MessageTypeSystem,
	}
	if err := messageRepo.Create(ctx, msg); err != nil {
		return fmt.Errorf("create system message: %w", err)
	}
	return nil
}

// resolveActorName looks up a user and returns their display name.
// Falls back to unknownActorName if the user cannot be found.
func resolveActorName(ctx context.Context, userRepo *repositories.UserRepo, userID uint) string {
	actor, err := userRepo.FindByID(ctx, userID)
	if err != nil {
		return unknownActorName
	}
	return actor.GetDisplayName()
}

// deduplicateIDs returns unique IDs from the input, excluding excludeID (if non-zero).
func deduplicateIDs(ids []uint, excludeID uint) []uint {
	seen := make(map[uint]struct{}, len(ids))
	result := make([]uint, 0, len(ids))
	for _, id := range ids {
		if _, exists := seen[id]; exists {
			continue
		}
		if excludeID != 0 && id == excludeID {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}
