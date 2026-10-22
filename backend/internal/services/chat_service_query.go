// internal/services/chat_service.go
package services

import (
	"context"
	"errors"
	"fmt"

	"messenger/internal/models"

	"gorm.io/gorm"
)

// MarkDelivered records that userID (a recipient) has received messages up to
// messageID in chatID. The pointer never regresses. Used by the WS `delivered`
// ack so the message author's bubbles can flip to ✓✓ (delivered).
func (s *ChatService) MarkDelivered(ctx context.Context, chatID, userID, messageID uint) error {
	return s.messageReceiptRepo.UpsertDelivered(ctx, chatID, userID, messageID)
}

// MarkReadReceipt records that userID has read messages up to messageID (and,
// implicitly, received them). Distinct from MarkChatAsRead, which drains the
// offline-replay queue — this maintains the durable read pointer for receipts.
func (s *ChatService) MarkReadReceipt(ctx context.Context, chatID, userID, messageID uint) error {
	return s.messageReceiptRepo.UpsertRead(ctx, chatID, userID, messageID)
}

// GetPeerReceipt returns peerUserID's delivered/read pointers in chatID, or nil
// if the peer has no receipt yet. Used on chat open to render checkmarks before
// any live message_status event arrives.
func (s *ChatService) GetPeerReceipt(ctx context.Context, chatID, peerUserID uint) (*models.MessageReceipt, error) {
	return s.messageReceiptRepo.GetPeerReceipt(ctx, chatID, peerUserID)
}

// GetMessages returns the full message history of a chat addressed to userID.
// For group scheme=2 messages the per-user envelope is resolved into Text/IV
// so the caller sees a uniform per-message ciphertext shape regardless of
// whether the chat is 1-on-1 or group.
func (s *ChatService) GetMessages(ctx context.Context, chatID, userID uint) ([]models.Message, error) {
	messages, err := s.messageRepo.GetAllByChatID(ctx, chatID)
	if err != nil {
		return nil, fmt.Errorf("get messages: %w", err)
	}
	if err := s.resolveEnvelopesForUser(ctx, messages, userID); err != nil {
		return nil, fmt.Errorf("resolve envelopes: %w", err)
	}
	return messages, nil
}

// GetRecentMessages gets the most recent N messages for a chat addressed to userID.
func (s *ChatService) GetRecentMessages(ctx context.Context, chatID, userID uint, limit int) ([]models.Message, error) {
	messages, err := s.messageRepo.GetRecentByChatID(ctx, chatID, limit)
	if err != nil {
		return nil, fmt.Errorf("get recent messages: %w", err)
	}
	if err := s.resolveEnvelopesForUser(ctx, messages, userID); err != nil {
		return nil, fmt.Errorf("resolve envelopes: %w", err)
	}
	return messages, nil
}

// GetLastMessageForChat retrieves the most recent non-deleted message for a chat.
// Deleted messages are skipped entirely so the chat-list preview never shows a "deleted" placeholder.
// For group scheme=2 messages userID's envelope is resolved so the chat-list preview
// path sees the same ciphertext shape as a 1-on-1 scheme=2 message — i.e. the
// "🔒 placeholder" path in formatLastMessage applies uniformly.
func (s *ChatService) GetLastMessageForChat(ctx context.Context, chatID, userID uint) (*models.Message, error) {
	msg, err := s.messageRepo.GetLastNonDeletedByChatID(ctx, chatID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, errNoMessages
		}
		return nil, fmt.Errorf("get last message: %w", err)
	}
	messages := []models.Message{*msg}
	if err := s.resolveEnvelopesForUser(ctx, messages, userID); err != nil {
		return nil, fmt.Errorf("resolve envelopes: %w", err)
	}
	return &messages[0], nil
}

// FillEnvelopeForUser is the single-message helper for callers outside the
// chat-list / chat-window fetch path (notably WebSocket unread-replay) that
// already have one models.Message in hand and need to substitute its Text/IV
// with the recipient's per-user ciphertext.
//
// Returns true when an envelope was applied. Returns false (without error) for
// non-group / non-scheme=2 messages, or when this user has no envelope for the
// message (they joined the group after the message was sent). Callers should
// treat false on a group scheme=2 message as "skip — this user isn't a recipient."
func (s *ChatService) FillEnvelopeForUser(ctx context.Context, m *models.Message, userID uint) (bool, error) {
	if m == nil ||
		m.Scheme != models.SchemeClientSide ||
		m.Text != "" || m.IV != "" {
		return false, nil
	}
	envelopes, err := s.envelopeRepo.FindForRecipient(ctx, userID, []uint{m.ID})
	if err != nil {
		return false, err
	}
	env, ok := envelopes[m.ID]
	if !ok {
		return false, nil
	}
	m.Text = env.Ciphertext
	m.IV = env.IV
	return true, nil
}

// resolveEnvelopesForUser fills in Text/IV from message_envelopes for every
// group scheme=2 message in the slice, addressed to userID. Messages without
// an envelope for this user (because they joined after the message was sent,
// for example) keep their empty Text/IV and the client renders a "🔒" placeholder.
// Embedded ReplyTo previews go through the same lookup so reply quotes don't
// silently show empty bubbles.
func (s *ChatService) resolveEnvelopesForUser(ctx context.Context, messages []models.Message, userID uint) error {
	if len(messages) == 0 {
		return nil
	}
	targetIDs := collectEnvelopeTargets(messages)
	if len(targetIDs) == 0 {
		return nil
	}
	envelopes, err := s.envelopeRepo.FindForRecipient(ctx, userID, targetIDs)
	if err != nil {
		return err
	}
	applyEnvelopes(messages, envelopes)
	return nil
}

// needsEnvelopeResolution returns true for scheme=2 messages whose ciphertext
// hasn't been resolved yet (group envelope rows: Text/IV both empty).
func needsEnvelopeResolution(m *models.Message) bool {
	return m != nil &&
		m.Scheme == models.SchemeClientSide &&
		m.Text == "" && m.IV == ""
}

// collectEnvelopeTargets walks the message slice and returns the IDs of every
// message (plus embedded ReplyTo preview) that still needs envelope resolution.
func collectEnvelopeTargets(messages []models.Message) []uint {
	var ids []uint
	for i := range messages {
		m := &messages[i]
		if needsEnvelopeResolution(m) {
			ids = append(ids, m.ID)
		}
		if needsEnvelopeResolution(m.ReplyTo) {
			ids = append(ids, m.ReplyTo.ID)
		}
	}
	return ids
}

// applyEnvelopes copies ciphertext+iv from the envelope map back into the
// matching message rows (and any embedded ReplyTo previews).
func applyEnvelopes(messages []models.Message, envelopes map[uint]models.MessageEnvelope) {
	fill := func(m *models.Message) {
		if env, ok := envelopes[m.ID]; ok {
			m.Text = env.Ciphertext
			m.IV = env.IV
		}
	}
	for i := range messages {
		m := &messages[i]
		fill(m)
		if m.ReplyTo != nil {
			fill(m.ReplyTo)
		}
	}
}

// GetUserChats retrieves all chats for a user (1-on-1 + groups)
// preloadUsers: if true, preloads User1 and User2 (use for display); if false, only loads IDs (use for presence/routing)
func (s *ChatService) GetUserChats(ctx context.Context, userID uint, preloadUsers bool) ([]models.Chat, error) {
	groupChatIDs, err := s.participantRepo.GetUserGroupChatIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get user group chats: %w", err)
	}

	chats, err := s.chatRepo.GetUserChatsIncludingGroups(ctx, userID, groupChatIDs, preloadUsers)
	if err != nil {
		return nil, fmt.Errorf("get user chats: %w", err)
	}
	return chats, nil
}

func (s *ChatService) FindChatByID(ctx context.Context, id uint) (*models.Chat, error) {
	chat, err := s.chatRepo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("find chat: %w", err)
	}
	return chat, nil
}

// FindChatByIDLight finds a chat without preloading users (for access checks only)
func (s *ChatService) FindChatByIDLight(ctx context.Context, id uint) (*models.Chat, error) {
	chat, err := s.chatRepo.FindByIDLight(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("find chat: %w", err)
	}
	return chat, nil
}

// GetUnreadMessagesForUser retrieves all unread messages for a user
func (s *ChatService) GetUnreadMessagesForUser(ctx context.Context, userID uint) ([]models.UnreadMessage, error) {
	unreadMessages, err := s.unreadMessageRepo.GetByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get unread messages: %w", err)
	}
	return unreadMessages, nil
}

// MarkChatAsRead marks all messages in a chat as read for a user
func (s *ChatService) MarkChatAsRead(ctx context.Context, userID, chatID uint) error {
	if err := s.unreadMessageRepo.DeleteByChat(ctx, userID, chatID); err != nil {
		return fmt.Errorf("mark chat as read: %w", err)
	}
	return nil
}

// DeleteUnreadForUser removes all unread records for a user (used after pending message delivery)
func (s *ChatService) DeleteUnreadForUser(ctx context.Context, userID uint) error {
	if err := s.unreadMessageRepo.DeleteByUser(ctx, userID); err != nil {
		return fmt.Errorf("delete unread for user: %w", err)
	}
	return nil
}

// GetUnreadCounts returns count of unread messages per chat for a user
func (s *ChatService) GetUnreadCounts(ctx context.Context, userID uint) (map[uint]int64, error) {
	counts, err := s.unreadMessageRepo.GetUnreadCounts(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get unread counts: %w", err)
	}
	return counts, nil
}
