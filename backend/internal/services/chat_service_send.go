// internal/services/chat_service.go
package services

import (
	"context"
	"errors"
	"fmt"

	"messenger/internal/models"
	"messenger/internal/repositories"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// prepareMessageBody normalizes a SendMessageInput into the (ciphertext, iv,
// scheme) triple that gets persisted. After the scheme=1 removal there are
// exactly two valid shapes:
//
//   - 1-on-1 scheme=2: Text + IV both non-empty, no Envelopes.
//   - Group scheme=2 pairwise: Envelopes non-empty, Text + IV ignored on the
//     row (per-recipient ciphertexts live in message_envelopes).
//
// Anything else (server-side scheme=1, missing IV, envelopes without scheme,
// etc.) is rejected — the server no longer encrypts on behalf of clients.
func (*ChatService) prepareMessageBody(in SendMessageInput) (ciphertext, iv string, scheme uint8, err error) {
	if in.Scheme != models.SchemeClientSide {
		return "", "", 0, errServerSchemeRemoved
	}
	if len(in.Envelopes) > 0 {
		// Group pairwise E2E: messages row carries no ciphertext, just the
		// scheme marker. Each recipient's ciphertext is in message_envelopes.
		return "", "", models.SchemeClientSide, nil
	}
	if in.IV == "" {
		return "", "", 0, errMissingIVForClientScheme
	}
	return in.Text, in.IV, models.SchemeClientSide, nil
}

// SendMessageAtomic sends a message and creates unread record atomically within a transaction
// This prevents TOCTOU race conditions where a user could come online between the presence check and unread save.
//
// For scheme=SchemeClientSide messages the server stores the supplied ciphertext + IV
// verbatim and the returned Message keeps both populated so callers can broadcast them
// to peer clients. For scheme=SchemeServerSide (or 0) the legacy behavior applies:
// server encrypts, then the returned Message has Text restored to plaintext + IV cleared.
func (s *ChatService) SendMessageAtomic(ctx context.Context, chatID, userID, recipientID uint, in SendMessageInput, isRecipientOffline bool) (*models.Message, error) {
	ciphertext, storedIV, effectiveScheme, err := s.prepareMessageBody(in)
	if err != nil {
		return nil, err
	}

	var message *models.Message

	// Wrap message creation + unread save in a single transaction
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Use transaction-aware repositories
		chatRepo := s.chatRepo.WithTx(tx)
		messageRepo := s.messageRepo.WithTx(tx)
		unreadRepo := s.unreadMessageRepo.WithTx(tx)

		// Verify user access
		if err := s.validateUserAccess(ctx, chatRepo, chatID, userID); err != nil {
			return err
		}

		// Validate reply message if specified
		replyPtr, err := s.validateReplyMessage(ctx, messageRepo, in.ReplyToID, chatID)
		if err != nil {
			return err
		}

		// Create the message
		message = &models.Message{
			ChatID:              chatID,
			UserID:              userID,
			Text:                ciphertext,
			IV:                  storedIV,
			Scheme:              effectiveScheme,
			ReplyToID:           replyPtr,
			ForwardedFromUserID: forwardedFromPtr(in.ForwardedFromUserID),
		}

		if err := messageRepo.Create(ctx, message); err != nil {
			return fmt.Errorf("create message: %w", err)
		}

		// Update chat's updated_at to reflect the new message for proper sorting
		if err := tx.Model(&models.Chat{}).Where("id = ?", chatID).Update("updated_at", message.CreatedAt).Error; err != nil {
			return fmt.Errorf("update chat timestamp: %w", err)
		}

		// Create unread record if recipient is offline
		if err := s.createUnreadIfNeeded(ctx, unreadRepo, isRecipientOffline, recipientID, message.ID, chatID); err != nil {
			return err
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	// Hand back the same content the caller would broadcast to other clients:
	//   - scheme=1: plaintext + empty IV (matches legacy callers / clients).
	//   - scheme=2: original ciphertext + client-supplied IV intact.
	if effectiveScheme == models.SchemeClientSide {
		message.Text = in.Text
		message.IV = in.IV
	} else {
		message.Text = in.Text
		message.IV = ""
	}

	return message, nil
}

// validateUserAccess checks if user is a participant in the chat (1-on-1 or group)
func (s *ChatService) validateUserAccess(ctx context.Context, chatRepo *repositories.ChatRepo, chatID, userID uint) error {
	chat, err := chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return errors.New("chat not found")
	}

	if chat.IsGroup {
		_, err := s.participantRepo.FindByUserAndChat(ctx, chatID, userID)
		if err != nil {
			return errors.New("unauthorized: user is not a participant in this group")
		}
		return nil
	}

	if !chat.HasUser(userID) {
		return errors.New("unauthorized: user is not a participant in this chat")
	}

	return nil
}

// validateReplyMessage validates reply message exists and belongs to the same chat
func (s *ChatService) validateReplyMessage(ctx context.Context, messageRepo *repositories.MessageRepo, replyToID, chatID uint) (*uint, error) {
	if replyToID == 0 {
		return nil, nil //nolint:nilnil // nil pointer and nil error is valid when no reply message specified
	}

	msg, err := messageRepo.FindByID(ctx, replyToID)
	if err != nil || msg.ChatID != chatID {
		return nil, errors.New("invalid reply message")
	}

	return &replyToID, nil
}

// PostCallSystemMessage creates a plaintext "missed call" system message in a
// 1-on-1 chat (UserID 0, Type system). If the recipient who missed the call is
// offline, it's queued to their unread-replay so they see it on reconnect. The
// row is returned so the WS handler can broadcast a normal `new` event for any
// online participant. Never E2E-encrypted — system messages are plaintext by
// design, like the group join/leave notices.
func (s *ChatService) PostCallSystemMessage(ctx context.Context, chatID, recipientID uint, text string, recipientOffline bool) (*models.Message, error) {
	msg := &models.Message{
		ChatID: chatID,
		UserID: 0,
		Text:   text,
		Type:   models.MessageTypeSystem,
	}
	if err := s.messageRepo.Create(ctx, msg); err != nil {
		return nil, fmt.Errorf("create call system message: %w", err)
	}
	if err := s.createUnreadIfNeeded(ctx, s.unreadMessageRepo, recipientOffline, recipientID, msg.ID, chatID); err != nil {
		s.logger.Warn("failed to queue missed-call unread",
			zap.Error(err),
			zap.Uint("recipient_id", recipientID),
			zap.Uint("chat_id", chatID),
		)
	}
	return msg, nil
}

// createUnreadIfNeeded creates an unread message record if recipient is offline
func (s *ChatService) createUnreadIfNeeded(ctx context.Context, unreadRepo *repositories.UnreadMessageRepo, isRecipientOffline bool, recipientID, messageID, chatID uint) error {
	if !isRecipientOffline {
		return nil
	}

	unreadMsg := &models.UnreadMessage{
		UserID:    recipientID,
		MessageID: messageID,
		ChatID:    chatID,
	}

	if err := unreadRepo.Create(ctx, unreadMsg); err != nil {
		// If unique constraint violated (duplicate), ignore the error
		// This can happen if the same message is marked unread twice (race condition)
		if !errors.Is(err, gorm.ErrDuplicatedKey) {
			return fmt.Errorf("create unread message: %w", err)
		}
	}

	return nil
}

// SendMessageAtomicGroup sends a message in a group chat, creating unread
// records for all offline members. For group pairwise E2E (scheme=2 with
// in.Envelopes set) each envelope is a per-recipient ciphertext stored in
// message_envelopes; Message.Text/IV are empty on the row.
func (s *ChatService) SendMessageAtomicGroup(ctx context.Context, chatID, userID uint, offlineUserIDs []uint, in SendMessageInput) (*models.Message, error) {
	if err := s.validateGroupEnvelopes(ctx, chatID, userID, in); err != nil {
		return nil, err
	}
	ciphertext, storedIV, effectiveScheme, err := s.prepareMessageBody(in)
	if err != nil {
		return nil, err
	}

	var message *models.Message
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return s.persistGroupMessage(ctx, tx, persistGroupArgs{
			chatID:          chatID,
			userID:          userID,
			offlineUserIDs:  offlineUserIDs,
			in:              in,
			ciphertext:      ciphertext,
			storedIV:        storedIV,
			effectiveScheme: effectiveScheme,
			out:             &message,
		})
	})
	if err != nil {
		return nil, err
	}

	// Hand back what callers can broadcast to clients without re-fetching:
	//   - scheme=1: plaintext + empty IV.
	//   - scheme=2 1-on-1: caller-supplied ciphertext + iv (no envelopes).
	//   - scheme=2 group: empty Text/IV on the row; envelopes are the source of truth.
	switch {
	case effectiveScheme == models.SchemeClientSide && len(in.Envelopes) > 0:
		message.Text = ""
		message.IV = ""
	case effectiveScheme == models.SchemeClientSide:
		message.Text = in.Text
		message.IV = in.IV
	default:
		message.Text = in.Text
		message.IV = ""
	}
	return message, nil
}

// persistGroupArgs bundles the inputs to persistGroupMessage so the helper's
// signature stays short (otherwise we'd be over the linter's parameter cap
// on top of the cognitive-complexity cap we're trying to dodge).
type persistGroupArgs struct {
	in              SendMessageInput
	out             **models.Message
	ciphertext      string
	storedIV        string
	offlineUserIDs  []uint
	chatID          uint
	userID          uint
	effectiveScheme uint8
}

// persistGroupMessage runs the inner transactional body of
// SendMessageAtomicGroup: access check, reply validation, message row
// insertion, envelope batch insertion, chat-timestamp bump, unread fan-out.
// Extracted from SendMessageAtomicGroup so its caller's gocognit score stays
// under the linter threshold.
func (s *ChatService) persistGroupMessage(ctx context.Context, tx *gorm.DB, a persistGroupArgs) error {
	chatRepo := s.chatRepo.WithTx(tx)
	messageRepo := s.messageRepo.WithTx(tx)
	envelopeRepo := s.envelopeRepo.WithTx(tx)
	unreadRepo := s.unreadMessageRepo.WithTx(tx)

	if err := s.validateUserAccess(ctx, chatRepo, a.chatID, a.userID); err != nil {
		return err
	}
	replyPtr, err := s.validateReplyMessage(ctx, messageRepo, a.in.ReplyToID, a.chatID)
	if err != nil {
		return err
	}
	message := &models.Message{
		ChatID:              a.chatID,
		UserID:              a.userID,
		Text:                a.ciphertext,
		IV:                  a.storedIV,
		Scheme:              a.effectiveScheme,
		ReplyToID:           replyPtr,
		ForwardedFromUserID: forwardedFromPtr(a.in.ForwardedFromUserID),
		Type:                models.MessageTypeUser,
	}
	if err := messageRepo.Create(ctx, message); err != nil {
		return fmt.Errorf("create message: %w", err)
	}
	*a.out = message

	if len(a.in.Envelopes) > 0 {
		envelopes := make([]models.MessageEnvelope, len(a.in.Envelopes))
		for i, e := range a.in.Envelopes {
			envelopes[i] = models.MessageEnvelope{
				MessageID:   message.ID,
				RecipientID: e.RecipientID,
				Ciphertext:  e.Ciphertext,
				IV:          e.IV,
			}
		}
		if err := envelopeRepo.CreateBatch(ctx, envelopes); err != nil {
			return fmt.Errorf("create envelopes: %w", err)
		}
	}

	if err := tx.Model(&models.Chat{}).Where("id = ?", a.chatID).Update("updated_at", message.CreatedAt).Error; err != nil {
		return fmt.Errorf("update chat timestamp: %w", err)
	}
	for _, recipientID := range a.offlineUserIDs {
		if err := s.createUnreadIfNeeded(ctx, unreadRepo, true, recipientID, message.ID, a.chatID); err != nil {
			return err
		}
	}
	return nil
}

// validateGroupEnvelopes enforces the pairwise E2E shape for a group send:
// every current participant must be addressed exactly once (no duplicates,
// no missing recipients, no strangers). The lazy-vault modal in the client
// guarantees every active user has a public_key, so this strict invariant
// is honest in practice. Performed before opening the transaction so we
// can fail fast with a clean error.
func (s *ChatService) validateGroupEnvelopes(ctx context.Context, chatID, senderID uint, in SendMessageInput) error {
	if in.Scheme != models.SchemeClientSide || len(in.Envelopes) == 0 {
		return nil
	}
	participantIDs, err := s.participantRepo.GetParticipantUserIDs(ctx, chatID)
	if err != nil {
		return fmt.Errorf("fetch participants: %w", err)
	}
	want := make(map[uint]struct{}, len(participantIDs))
	for _, pid := range participantIDs {
		want[pid] = struct{}{}
	}
	if _, ok := want[senderID]; !ok {
		// Caught later by validateUserAccess too, but earlier here keeps the
		// error message tight.
		return errors.New("sender is not a participant in this group")
	}
	seen := make(map[uint]struct{}, len(in.Envelopes))
	for _, e := range in.Envelopes {
		if e.Ciphertext == "" || e.IV == "" {
			return errors.New("envelope ciphertext and iv must be non-empty")
		}
		if _, dup := seen[e.RecipientID]; dup {
			return fmt.Errorf("duplicate envelope for recipient %d", e.RecipientID)
		}
		if _, ok := want[e.RecipientID]; !ok {
			return fmt.Errorf("envelope for non-participant %d", e.RecipientID)
		}
		seen[e.RecipientID] = struct{}{}
	}
	if len(seen) != len(want) {
		return fmt.Errorf("envelopes cover %d of %d participants", len(seen), len(want))
	}
	return nil
}
