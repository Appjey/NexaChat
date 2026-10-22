// internal/services/chat_service.go
package services

import (
	"context"
	"errors"
	"fmt"

	"messenger/internal/models"
	"messenger/internal/repositories"
	"messenger/internal/storage"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	errNoMessages               = errors.New("no messages found")
	errMissingIVForClientScheme = errors.New("iv is required for client-encrypted scheme")
	errServerSchemeRemoved      = errors.New("server-side encryption (scheme=1) is no longer supported; please update your client")
)

// MessageEnvelopeInput is a single per-recipient ciphertext inside a group
// scheme=2 send. The sender (client) encrypts the plaintext once per
// recipient (including themselves) and ships the resulting envelopes here.
type MessageEnvelopeInput struct {
	RecipientID uint
	Ciphertext  string
	IV          string
}

// SendMessageInput captures the per-message payload for SendMessageAtomic /
// SendMessageAtomicGroup. After the scheme=1 removal there are exactly two
// valid shapes (the service rejects anything else):
//
//   - 1-on-1 scheme=2: Scheme == models.SchemeClientSide, Text + IV both
//     non-empty, no Envelopes. Server stores both as opaque blobs.
//   - Group scheme=2 pairwise: Scheme == models.SchemeClientSide, Envelopes
//     non-empty (one per current participant including the sender). Text + IV
//     on the persisted message row are empty by convention; per-recipient
//     ciphertexts live in the message_envelopes table.
type SendMessageInput struct {
	Text                string
	IV                  string
	Scheme              uint8
	ReplyToID           uint
	ForwardedFromUserID uint
	Envelopes           []MessageEnvelopeInput
}

// forwardedFromPtr maps a zero id to nil so non-forwarded messages leave the
// column NULL, mirroring how ReplyToID is stored as a nullable pointer.
func forwardedFromPtr(id uint) *uint {
	if id == 0 {
		return nil
	}
	return &id
}

// ChatService handles business logic for chats, messages, and unread tracking.
type ChatService struct {
	db                 *gorm.DB
	logger             *zap.Logger
	chatRepo           *repositories.ChatRepo
	participantRepo    *repositories.ChatParticipantRepo
	messageRepo        *repositories.MessageRepo
	envelopeRepo       *repositories.MessageEnvelopeRepo
	unreadMessageRepo  *repositories.UnreadMessageRepo
	messageReceiptRepo *repositories.MessageReceiptRepo
	fileStorage        storage.Storage
}

// NewChatService creates a new ChatService.
func NewChatService(
	db *gorm.DB,
	logger *zap.Logger,
	chatRepo *repositories.ChatRepo,
	participantRepo *repositories.ChatParticipantRepo,
	messageRepo *repositories.MessageRepo,
	envelopeRepo *repositories.MessageEnvelopeRepo,
	unreadMessageRepo *repositories.UnreadMessageRepo,
	messageReceiptRepo *repositories.MessageReceiptRepo,
	fileStorage storage.Storage,
) *ChatService {
	return &ChatService{
		db:                 db,
		logger:             logger,
		chatRepo:           chatRepo,
		participantRepo:    participantRepo,
		messageRepo:        messageRepo,
		envelopeRepo:       envelopeRepo,
		unreadMessageRepo:  unreadMessageRepo,
		messageReceiptRepo: messageReceiptRepo,
		fileStorage:        fileStorage,
	}
}

// CreateChat creates a 1-on-1 chat between two users, returning the existing chat if one already exists.
// Self-chats (user1==user2) are rejected here — use EnsureFavoritesChat instead, which is the
// only sanctioned path for creating the special "Saved Messages" chat.
func (s *ChatService) CreateChat(ctx context.Context, user1ID, user2ID uint) (*models.Chat, error) {
	if user1ID == user2ID {
		return nil, errors.New("cannot create chat with self")
	}

	// Normalize IDs (smaller always first) to match BeforeCreate hook
	if user1ID > user2ID {
		user1ID, user2ID = user2ID, user1ID
	}

	// Check for existing chat
	existingChat, err := s.chatRepo.FindByUsers(ctx, user1ID, user2ID)
	if err == nil {
		return existingChat, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("check for existing chat: %w", err)
	}

	chat := &models.Chat{
		User1ID: &user1ID,
		User2ID: &user2ID,
	}

	if err := s.chatRepo.Create(ctx, chat); err != nil {
		// If unique constraint violated due to race condition, fetch existing chat
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			raceChat, fetchErr := s.chatRepo.FindByUsers(ctx, user1ID, user2ID)
			if fetchErr == nil {
				return raceChat, nil
			}
			return nil, fmt.Errorf("fetch existing chat after race condition: %w", fetchErr)
		}
		return nil, fmt.Errorf("create chat: %w", err)
	}
	return chat, nil
}

// EnsureFavoritesChat returns the user's "Saved Messages" chat, creating it if it doesn't
// exist yet. The favorites chat is a 1-on-1 chat where user1_id == user2_id == userID;
// the unique index on (user1_id, user2_id) guarantees idempotency — concurrent calls
// land on the same row. Called on registration and on startup backfill.
func (s *ChatService) EnsureFavoritesChat(ctx context.Context, userID uint) (*models.Chat, error) {
	existing, err := s.chatRepo.FindByUsers(ctx, userID, userID)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("check for favorites chat: %w", err)
	}

	chat := &models.Chat{
		User1ID: &userID,
		User2ID: &userID,
	}
	if err := s.chatRepo.Create(ctx, chat); err != nil {
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			raceChat, fetchErr := s.chatRepo.FindByUsers(ctx, userID, userID)
			if fetchErr == nil {
				return raceChat, nil
			}
			return nil, fmt.Errorf("fetch favorites chat after race: %w", fetchErr)
		}
		return nil, fmt.Errorf("create favorites chat: %w", err)
	}
	return chat, nil
}

// EnsureFavoritesChatsForAllUsers backfills the favorites chat for every existing user.
// Run once at startup — idempotent thanks to the unique constraint. Errors per-user
// are logged but don't abort the batch.
func (s *ChatService) EnsureFavoritesChatsForAllUsers(ctx context.Context, userIDs []uint) {
	for _, uid := range userIDs {
		if _, err := s.EnsureFavoritesChat(ctx, uid); err != nil {
			s.logger.Warn("backfill favorites chat failed", zap.Uint("user_id", uid), zap.Error(err))
		}
	}
}

// IsFavoritesChat reports whether a chat is a user's self-chat (Saved Messages).
// For 1-on-1 chats only; group chats always return false (their user1/user2 are NULL).
func IsFavoritesChat(chat *models.Chat) bool {
	if chat.IsGroup {
		return false
	}
	return chat.User1ID != nil && chat.User2ID != nil && *chat.User1ID == *chat.User2ID
}
