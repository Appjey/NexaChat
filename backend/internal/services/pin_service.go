package services

import (
	"context"
	"errors"
	"fmt"

	"messenger/internal/i18n"
	"messenger/internal/models"
	"messenger/internal/repositories"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// maxPinnedPerChat is the maximum number of pinned messages allowed per chat.
const maxPinnedPerChat = 50

// PinService handles business logic for pinning and unpinning messages.
type PinService struct {
	db              *gorm.DB
	logger          *zap.Logger
	pinnedRepo      *repositories.PinnedMessageRepo
	messageRepo     *repositories.MessageRepo
	envelopeRepo    *repositories.MessageEnvelopeRepo
	chatRepo        *repositories.ChatRepo
	participantRepo *repositories.ChatParticipantRepo
	userRepo        *repositories.UserRepo
}

// NewPinService creates a new PinService.
func NewPinService(
	db *gorm.DB,
	logger *zap.Logger,
	pinnedRepo *repositories.PinnedMessageRepo,
	messageRepo *repositories.MessageRepo,
	envelopeRepo *repositories.MessageEnvelopeRepo,
	chatRepo *repositories.ChatRepo,
	participantRepo *repositories.ChatParticipantRepo,
	userRepo *repositories.UserRepo,
) *PinService {
	return &PinService{
		db:              db,
		logger:          logger,
		pinnedRepo:      pinnedRepo,
		messageRepo:     messageRepo,
		envelopeRepo:    envelopeRepo,
		chatRepo:        chatRepo,
		participantRepo: participantRepo,
		userRepo:        userRepo,
	}
}

// PinMessage pins a message in a chat.
// 1-on-1: any participant can pin. Groups: admin or creator only.
func (s *PinService) PinMessage(ctx context.Context, chatID, messageID, userID uint) (*models.PinnedMessage, error) {
	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return nil, errors.New("chat not found")
	}

	if err := s.checkPinPermission(ctx, chat, userID); err != nil {
		return nil, err
	}

	msg, err := s.messageRepo.FindByID(ctx, messageID)
	if err != nil {
		return nil, errors.New("message not found")
	}
	if msg.ChatID != chatID {
		return nil, errors.New("message does not belong to this chat")
	}
	if msg.IsDeleted {
		return nil, errors.New("cannot pin a deleted message")
	}

	already, err := s.pinnedRepo.IsPinned(ctx, chatID, messageID)
	if err != nil {
		return nil, fmt.Errorf("check pinned: %w", err)
	}
	if already {
		return nil, errors.New("message is already pinned")
	}

	count, err := s.pinnedRepo.CountByChatID(ctx, chatID)
	if err != nil {
		return nil, fmt.Errorf("count pinned: %w", err)
	}
	if count >= maxPinnedPerChat {
		return nil, fmt.Errorf("cannot pin more than %d messages per chat", maxPinnedPerChat)
	}

	pin := &models.PinnedMessage{
		ChatID:    chatID,
		MessageID: messageID,
		PinnedBy:  userID,
	}

	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		pinnedRepo := s.pinnedRepo.WithTx(tx)
		messageRepo := s.messageRepo.WithTx(tx)

		if err := pinnedRepo.Create(ctx, pin); err != nil {
			return fmt.Errorf("create pin: %w", err)
		}

		actorName := resolveActorName(ctx, s.userRepo, userID)
		sysText := i18n.MessagePinned(actorName)
		return createSystemMessage(ctx, messageRepo, chatID, sysText)
	})
	if err != nil {
		return nil, err
	}

	return pin, nil
}

// UnpinMessage removes a pin from a message.
// Same access control as PinMessage.
func (s *PinService) UnpinMessage(ctx context.Context, chatID, messageID, userID uint) error {
	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return errors.New("chat not found")
	}

	if err := s.checkPinPermission(ctx, chat, userID); err != nil {
		return err
	}

	pinned, err := s.pinnedRepo.IsPinned(ctx, chatID, messageID)
	if err != nil {
		return fmt.Errorf("check pinned: %w", err)
	}
	if !pinned {
		return errors.New("message is not pinned")
	}

	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		pinnedRepo := s.pinnedRepo.WithTx(tx)
		messageRepo := s.messageRepo.WithTx(tx)

		if err := pinnedRepo.Delete(ctx, chatID, messageID); err != nil {
			return fmt.Errorf("delete pin: %w", err)
		}

		actorName := resolveActorName(ctx, s.userRepo, userID)
		sysText := i18n.MessageUnpinned(actorName)
		return createSystemMessage(ctx, messageRepo, chatID, sysText)
	})
}

// GetPinnedMessages returns all pinned messages for a chat, decrypted, most recent first.
func (s *PinService) GetPinnedMessages(ctx context.Context, chatID, userID uint) ([]models.PinnedMessage, error) {
	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return nil, errors.New("chat not found")
	}

	if err := s.checkChatAccess(ctx, chat, userID); err != nil {
		return nil, err
	}

	pins, err := s.pinnedRepo.GetByChatID(ctx, chatID)
	if err != nil {
		return nil, fmt.Errorf("get pinned messages: %w", err)
	}

	// Resolve per-user envelopes for group scheme=2 pins. The pinned message row
	// has empty Text/IV; the real ciphertext lives in message_envelopes addressed
	// to this user. Pins without an envelope for this user (joined after the pin)
	// stay empty and the UI renders a "🔒" placeholder.
	var envelopeTargetIDs []uint
	for i := range pins {
		msg := &pins[i].Message
		if msg.Scheme == models.SchemeClientSide && msg.Text == "" && msg.IV == "" {
			envelopeTargetIDs = append(envelopeTargetIDs, msg.ID)
		}
	}
	if len(envelopeTargetIDs) > 0 {
		envelopes, err := s.envelopeRepo.FindForRecipient(ctx, userID, envelopeTargetIDs)
		if err != nil {
			return nil, fmt.Errorf("resolve pin envelopes: %w", err)
		}
		for i := range pins {
			msg := &pins[i].Message
			if env, ok := envelopes[msg.ID]; ok {
				msg.Text = env.Ciphertext
				msg.IV = env.IV
			}
		}
	}

	// Legacy scheme=1 / scheme=0 pinned messages can no longer be decrypted
	// (server key removed). Wipe Text/IV so clients render a "🔒 encrypted
	// message" placeholder rather than garbled ciphertext. After the planned
	// history-purge migration there should be no such rows left.
	for i := range pins {
		msg := &pins[i].Message
		if msg.Scheme != models.SchemeClientSide {
			msg.Text = ""
			msg.IV = ""
		}
	}

	return pins, nil
}

// checkPinPermission validates the user can pin/unpin in the given chat.
func (s *PinService) checkPinPermission(ctx context.Context, chat *models.Chat, userID uint) error {
	if chat.IsGroup {
		p, err := s.participantRepo.FindByUserAndChat(ctx, chat.ID, userID)
		if err != nil {
			return errors.New("access denied")
		}
		if !p.IsAdmin() {
			return errors.New("admin or creator role required to pin messages")
		}
		return nil
	}
	if !chat.HasUser(userID) {
		return errors.New("access denied")
	}
	return nil
}

// checkChatAccess validates the user is a participant of the chat (read-only check).
func (s *PinService) checkChatAccess(ctx context.Context, chat *models.Chat, userID uint) error {
	if chat.IsGroup {
		if _, err := s.participantRepo.FindByUserAndChat(ctx, chat.ID, userID); err != nil {
			return errors.New("access denied")
		}
		return nil
	}
	if !chat.HasUser(userID) {
		return errors.New("access denied")
	}
	return nil
}
