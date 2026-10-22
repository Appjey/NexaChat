// internal/services/chat_service.go
package services

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"messenger/internal/models"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// EditMessage allows a user to edit their own message. The newText / newIV /
// scheme trio follows the same convention as SendMessageInput — for 1-on-1
// scheme=2 edits pass new ciphertext + iv; for group scheme=2 edits pass the
// new envelope set in in.Envelopes and the server replaces the old envelopes
// wholesale.
//
// EditMessage refuses to switch a message between schemes — once a message
// is stored under one scheme, edits must keep that scheme (mixing would
// leave half the readers unable to decrypt).
func (s *ChatService) EditMessage(ctx context.Context, messageID, userID uint, in SendMessageInput) error {
	message, err := s.messageRepo.FindByID(ctx, messageID)
	if err != nil {
		return errors.New("message not found")
	}
	if err := validateEditPrechecks(message, userID, in); err != nil {
		return err
	}

	// Group scheme=2 edit: validate against current participants, replace the
	// whole envelope set, keep messages.text/iv empty.
	if len(in.Envelopes) > 0 {
		if err := s.validateGroupEnvelopes(ctx, message.ChatID, userID, in); err != nil {
			return err
		}
		return s.replaceEnvelopes(ctx, messageID, in.Envelopes)
	}

	ciphertext, newIV, _, err := s.prepareMessageBody(in)
	if err != nil {
		return err
	}
	if err := s.messageRepo.UpdateMessage(ctx, messageID, ciphertext, newIV); err != nil {
		return fmt.Errorf("update message: %w", err)
	}
	return nil
}

// validateEditPrechecks runs all the ownership / state / scheme-match checks
// that apply regardless of whether the edit is 1-on-1 or group envelopes.
// Extracted so EditMessage stays under the gocognit threshold.
func validateEditPrechecks(message *models.Message, userID uint, in SendMessageInput) error {
	if message.UserID != userID {
		return errors.New("unauthorized: you can only edit your own messages")
	}
	if message.IsDeleted {
		return errors.New("cannot edit deleted message")
	}
	// Envelope-based group edits leave in.Text empty by convention; only run
	// the length check on the other branches.
	if len(in.Envelopes) == 0 {
		if in.Text == "" || len(in.Text) > 10000 {
			return errors.New("invalid message length")
		}
	}
	// Disallow scheme switches mid-life. scheme==0 is treated as scheme=1 on
	// both sides for legacy rows that pre-date the column.
	storedScheme := message.Scheme
	if storedScheme == 0 {
		storedScheme = models.SchemeServerSide
	}
	requestedScheme := in.Scheme
	if requestedScheme == 0 {
		requestedScheme = models.SchemeServerSide
	}
	if requestedScheme != storedScheme {
		return errors.New("cannot change encryption scheme on edit")
	}
	return nil
}

// replaceEnvelopes wipes the existing envelope set for messageID and writes a
// fresh one inside a single transaction. The message row's edited_at gets
// bumped via UpdateMessage so callers don't need a second round-trip.
func (s *ChatService) replaceEnvelopes(ctx context.Context, messageID uint, in []MessageEnvelopeInput) error {
	envelopes := make([]models.MessageEnvelope, len(in))
	for i, e := range in {
		envelopes[i] = models.MessageEnvelope{
			MessageID:   messageID,
			RecipientID: e.RecipientID,
			Ciphertext:  e.Ciphertext,
			IV:          e.IV,
		}
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		envelopeRepo := s.envelopeRepo.WithTx(tx)
		messageRepo := s.messageRepo.WithTx(tx)
		if err := envelopeRepo.DeleteByMessageID(ctx, messageID); err != nil {
			return fmt.Errorf("delete old envelopes: %w", err)
		}
		if err := envelopeRepo.CreateBatch(ctx, envelopes); err != nil {
			return fmt.Errorf("create new envelopes: %w", err)
		}
		if err := messageRepo.UpdateMessage(ctx, messageID, "", ""); err != nil {
			return fmt.Errorf("touch message: %w", err)
		}
		return nil
	})
}

// DeleteMessage marks a message as deleted, wipes its content from the DB, and purges any attachments
// (both the rows and the files in object storage). The row itself is kept so that replies pointing
// at this message still render a "deleted" placeholder in their quote block.
func (s *ChatService) DeleteMessage(ctx context.Context, messageID, userID uint) error {
	message, err := s.messageRepo.FindByID(ctx, messageID)
	if err != nil {
		return errors.New("message not found")
	}

	if message.UserID != userID {
		return errors.New("unauthorized: you can only delete your own messages")
	}

	if message.IsDeleted {
		return errors.New("message already deleted")
	}

	// Collect attachment storage keys before we blow away the rows.
	var storageKeys []string
	if err := s.db.WithContext(ctx).Model(&models.Attachment{}).
		Where("message_id = ?", messageID).
		Pluck("storage_key", &storageKeys).Error; err != nil {
		return fmt.Errorf("fetch attachment keys: %w", err)
	}

	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Wipe attachment envelopes first (subquery on attachments) before
		// the attachments themselves disappear and the subquery returns empty.
		if err := tx.Where("attachment_id IN (SELECT id FROM attachments WHERE message_id = ?)", messageID).Delete(&models.AttachmentEnvelope{}).Error; err != nil {
			return fmt.Errorf("delete attachment envelopes: %w", err)
		}
		// Wipe attachment rows for this message
		if err := tx.Unscoped().Where("message_id = ?", messageID).Delete(&models.Attachment{}).Error; err != nil {
			return fmt.Errorf("delete attachments: %w", err)
		}
		// Drop unread entries so offline recipients don't see a ghost of this message
		if err := tx.Unscoped().Where("message_id = ?", messageID).Delete(&models.UnreadMessage{}).Error; err != nil {
			return fmt.Errorf("delete unread entries: %w", err)
		}
		// Drop pin entries — a deleted message can't remain pinned
		if err := tx.Unscoped().Where("message_id = ?", messageID).Delete(&models.PinnedMessage{}).Error; err != nil {
			return fmt.Errorf("delete pin entries: %w", err)
		}
		// Drop per-recipient envelopes (no-op for non-group / scheme=1 messages).
		if err := tx.Where("message_id = ?", messageID).Delete(&models.MessageEnvelope{}).Error; err != nil {
			return fmt.Errorf("delete envelopes: %w", err)
		}
		// Mark the message deleted and clear its content. The row stays so reply chains keep resolving.
		if err := tx.Model(&models.Message{}).
			Where("id = ?", messageID).
			Updates(map[string]interface{}{
				"is_deleted": true,
				"text":       "",
				"iv":         "",
			}).Error; err != nil {
			return fmt.Errorf("mark message deleted: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	// Best-effort storage cleanup (doesn't block the delete op)
	s.deleteStorageFiles(storageKeys)

	return nil
}

// ClearChat hard-deletes all messages, attachments and unread records in a chat.
// For groups, only admin/creator can clear.
func (s *ChatService) ClearChat(ctx context.Context, chatID, userID uint) error {
	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return errors.New("chat not found")
	}

	if err := s.checkChatAccess(ctx, chat, userID, true); err != nil {
		return err
	}

	storageKeys, err := s.purgeMessagesAndAttachments(ctx, chatID)
	if err != nil {
		return err
	}
	s.deleteStorageFiles(storageKeys)
	return nil
}

// DeleteChat hard-deletes a chat and all its messages, attachments, and unread records.
// For groups, use GroupService.DeleteGroup instead — this is for 1-on-1 only.
func (s *ChatService) DeleteChat(ctx context.Context, chatID, userID uint) error {
	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return errors.New("chat not found")
	}
	if chat.IsGroup {
		return errors.New("use group delete endpoint for group chats")
	}
	if !chat.HasUser(userID) {
		return errors.New("access denied")
	}
	if IsFavoritesChat(chat) {
		return errors.New("favorites chat cannot be deleted, only cleared")
	}

	storageKeys, err := s.purgeChat(ctx, chatID)
	if err != nil {
		return err
	}
	s.deleteStorageFiles(storageKeys)
	return nil
}

// checkChatAccess verifies user has access to the chat. For groups with requireAdmin=true, checks admin role.
func (s *ChatService) checkChatAccess(ctx context.Context, chat *models.Chat, userID uint, requireAdmin bool) error {
	if chat.IsGroup {
		p, err := s.participantRepo.FindByUserAndChat(ctx, chat.ID, userID)
		if err != nil {
			return errors.New("access denied")
		}
		if requireAdmin && !p.IsAdmin() {
			return errors.New("admin or creator role required")
		}
		return nil
	}
	if !chat.HasUser(userID) {
		return errors.New("access denied")
	}
	return nil
}

// purgeMessagesAndAttachments hard-deletes messages, attachments and unread records for a chat.
// Returns storage keys of deleted attachments for cleanup.
func (s *ChatService) purgeMessagesAndAttachments(ctx context.Context, chatID uint) ([]string, error) {
	// Collect attachment storage keys before deleting
	var storageKeys []string
	if err := s.db.WithContext(ctx).Model(&models.Attachment{}).
		Where("message_id IN (SELECT id FROM messages WHERE chat_id = ?)", chatID).
		Pluck("storage_key", &storageKeys).Error; err != nil {
		return nil, fmt.Errorf("fetch attachment keys: %w", err)
	}

	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Delete pinned messages
		if err := tx.Unscoped().Where("chat_id = ?", chatID).Delete(&models.PinnedMessage{}).Error; err != nil {
			return fmt.Errorf("delete pinned messages: %w", err)
		}
		// Delete unread messages
		if err := tx.Unscoped().Where("chat_id = ?", chatID).Delete(&models.UnreadMessage{}).Error; err != nil {
			return fmt.Errorf("delete unread messages: %w", err)
		}
		// Delete attachment envelopes (subquery on attachments) BEFORE the
		// attachments themselves are gone — same reasoning as DeleteMessage.
		if err := tx.Where("attachment_id IN (SELECT id FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?))", chatID).Delete(&models.AttachmentEnvelope{}).Error; err != nil {
			return fmt.Errorf("delete attachment envelopes: %w", err)
		}
		// Delete attachments
		if err := tx.Unscoped().Where("message_id IN (SELECT id FROM messages WHERE chat_id = ?)", chatID).Delete(&models.Attachment{}).Error; err != nil {
			return fmt.Errorf("delete attachments: %w", err)
		}
		// Delete per-recipient envelopes for all messages in this chat
		if err := tx.Where("message_id IN (SELECT id FROM messages WHERE chat_id = ?)", chatID).Delete(&models.MessageEnvelope{}).Error; err != nil {
			return fmt.Errorf("delete envelopes: %w", err)
		}
		// Clear reply references to avoid FK constraint issues
		if err := tx.Model(&models.Message{}).Where("chat_id = ? AND reply_to_id IS NOT NULL", chatID).Update("reply_to_id", nil).Error; err != nil {
			return fmt.Errorf("clear reply references: %w", err)
		}
		// Hard-delete messages
		if err := tx.Unscoped().Where("chat_id = ?", chatID).Delete(&models.Message{}).Error; err != nil {
			return fmt.Errorf("delete messages: %w", err)
		}
		return nil
	})

	return storageKeys, err
}

// purgeChat hard-deletes a chat and all its data. Returns storage keys for cleanup.
func (s *ChatService) purgeChat(ctx context.Context, chatID uint) ([]string, error) {
	storageKeys, err := s.purgeMessagesAndAttachments(ctx, chatID)
	if err != nil {
		return nil, err
	}

	// Hard-delete the chat itself (Unscoped bypasses GORM soft-delete)
	if err := s.db.WithContext(ctx).Unscoped().Delete(&models.Chat{}, chatID).Error; err != nil {
		return storageKeys, fmt.Errorf("delete chat: %w", err)
	}

	return storageKeys, nil
}

// deleteStorageFiles removes files from storage in parallel (best-effort, errors are logged).
// A bounded pool keeps concurrency sane — deleting 10 attachments sequentially on a slow
// link easily stalls the caller for seconds; parallel deletes complete in ~1 round-trip.
func (s *ChatService) deleteStorageFiles(keys []string) {
	if len(keys) == 0 {
		return
	}

	const maxParallel = 8
	sem := make(chan struct{}, maxParallel)
	var wg sync.WaitGroup

	for _, key := range keys {
		wg.Add(1)
		sem <- struct{}{}
		go func(k string) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := s.fileStorage.Delete(k); err != nil {
				s.logger.Warn("failed to delete file from storage", zap.Error(err), zap.String("key", k))
			}
		}(key)
	}
	wg.Wait()
}
