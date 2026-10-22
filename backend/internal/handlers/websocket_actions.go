package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"messenger/internal/i18n"
	"messenger/internal/models"
	"messenger/internal/services"

	"go.uber.org/zap"
)

// pushBodyAttachmentPlaceholder is the fallback body shown in a push notification when the
// sender's message is whitespace-only — this happens when they post a message with only
// file attachments. The composer sends `text: ' '` to satisfy the non-empty-text rule, so
// without the substitution recipients would see an empty notification body.
const pushBodyAttachmentPlaceholder = i18n.AttachmentPlaceholder

// addE2EFieldsToBroadcast tacks `scheme` + `iv` onto a WS broadcast payload, but only
// when the message is scheme=2 (client-side encrypted). For legacy scheme=1 we leave
// the broadcast minimal — the text is already plaintext and old clients ignore unknown
// fields anyway, but emitting them adds noise.
//
// For group scheme=2 messages (envelopes != nil) the broadcast also carries the
// full envelope set and an empty top-level text/iv — each receiving client picks
// the envelope addressed to its own user_id and decrypts that.
func addE2EFieldsToBroadcast(data map[string]any, scheme uint8, iv string, envelopes []messageEnvelopeAction) {
	if scheme != models.SchemeClientSide {
		return
	}
	data["scheme"] = models.SchemeClientSide
	if len(envelopes) > 0 {
		// Group pairwise: per-recipient ciphertexts. Override text/iv to make it
		// obvious to clients that the top-level body is intentionally empty.
		data["text"] = ""
		data["iv"] = ""
		data["envelopes"] = envelopes
		return
	}
	data["iv"] = iv
}

// handleSendMessage processes a new message
func (h *webSocketHandler) handleSendMessage(ctx context.Context, userID uint, msgData messageAction) error {
	// Server-side encryption (scheme=1) was removed. Clients must encrypt
	// client-side and send scheme=2 with either text+iv (1-on-1) or envelopes
	// (group). Anything else is a stale or buggy client — surface a clear
	// error so the user knows to update their app.
	if msgData.Scheme != models.SchemeClientSide {
		return &wsError{message: "Client update required: server-side encryption is no longer supported"}
	}
	// For group pairwise E2E (envelopes set), the top-level text is empty by design.
	// In every other path we still require non-empty text + size limit.
	if len(msgData.Envelopes) == 0 {
		if msgData.Text == "" {
			return &wsError{message: "Message cannot be empty"}
		}
		if len(msgData.Text) > maxMessageSize {
			return &wsError{message: "Message too large (max 10KB)"}
		}
		if msgData.IV == "" {
			return &wsError{message: "iv is required for client-encrypted messages"}
		}
	}

	// Check access to chat
	chat, err := h.chatService.FindChatByIDLight(ctx, msgData.ChatID)
	if err != nil {
		return &wsError{message: errMsgChatAccessDenied}
	}
	if len(msgData.Envelopes) > 0 && !chat.IsGroup {
		return &wsError{message: "envelopes only valid for group chats"}
	}

	var message *models.Message

	if chat.IsGroup {
		message, err = h.handleSendGroupMessage(ctx, userID, chat, msgData)
	} else {
		message, err = h.handleSendDirectMessage(ctx, userID, chat, msgData)
	}
	if err != nil {
		return err
	}

	h.broadcastNewMessage(ctx, userID, msgData, message)
	return nil
}

// broadcastNewMessage builds and fans out the `new` event for a freshly created
// message. Shared by the WS send path and the HTTP forward endpoint.
func (h *webSocketHandler) broadcastNewMessage(ctx context.Context, userID uint, msgData messageAction, message *models.Message) {
	replyToIDVal := uint(0)
	if message.ReplyToID != nil {
		replyToIDVal = *message.ReplyToID
	}
	forwardedFromVal := uint(0)
	if message.ForwardedFromUserID != nil {
		forwardedFromVal = *message.ForwardedFromUserID
	}

	broadcastData := map[string]any{
		"action":                 "new",
		"chat_id":                msgData.ChatID,
		"user_id":                userID,
		"text":                   msgData.Text,
		"reply_to_id":            replyToIDVal,
		"forwarded_from_user_id": forwardedFromVal,
		"id":                     message.ID,
		"created_at":             message.CreatedAt,
		"is_deleted":             false,
	}
	addE2EFieldsToBroadcast(broadcastData, message.Scheme, message.IV, msgData.Envelopes)
	msgJSON, err := json.Marshal(broadcastData)
	if err != nil {
		h.logger.Error("json marshal error", zap.Error(err), zap.Uint("message_id", message.ID))
		return
	}
	if err := h.broadcastToChat(ctx, msgData.ChatID, msgJSON); err != nil {
		h.logger.Error("failed to broadcast message", zap.Error(err), zap.Uint("chat_id", msgData.ChatID))
	}
}

// handleSendDirectMessage handles sending a message in a 1-on-1 chat.
func (h *webSocketHandler) handleSendDirectMessage(ctx context.Context, userID uint, chat *models.Chat, msgData messageAction) (*models.Message, error) {
	if !chat.HasUser(userID) {
		return nil, &wsError{message: errMsgChatAccessDenied}
	}

	otherUserID := chat.GetUser1ID()
	if chat.GetUser1ID() == userID {
		otherUserID = chat.GetUser2ID()
	}

	isRecipientOffline := !h.presenceService.IsUserOnline(otherUserID)

	msg, err := h.chatService.SendMessageAtomic(ctx, msgData.ChatID, userID, otherUserID, services.SendMessageInput{
		Text:                msgData.Text,
		IV:                  msgData.IV,
		Scheme:              msgData.Scheme,
		ReplyToID:           msgData.ReplyToID,
		ForwardedFromUserID: msgData.ForwardedFromUserID,
	}, isRecipientOffline)
	if err != nil {
		h.logger.Error("error sending message",
			zap.Error(err),
			zap.Uint("user_id", userID),
			zap.Uint("chat_id", msgData.ChatID),
		)
		return nil, &wsError{message: "Failed to send message"}
	}

	// Push notification for direct message. Skip self-chat ("Saved Messages"):
	// the recipient is the sender, so a push would notify the author's own
	// other devices about their own message.
	if otherUserID != userID && h.pushService != nil && h.pushService.IsEnabled() {
		go h.sendPushNotification(userID, otherUserID, msgData.ChatID, pushBodyFromMessage(msgData))
	}

	return msg, nil
}

// handleSendGroupMessage handles sending a message in a group chat.
func (h *webSocketHandler) handleSendGroupMessage(ctx context.Context, userID uint, chat *models.Chat, msgData messageAction) (*models.Message, error) {
	if h.participantRepo == nil {
		return nil, &wsError{message: "Group chat not supported"}
	}

	// Verify membership
	_, err := h.participantRepo.FindByUserAndChat(ctx, chat.ID, userID)
	if err != nil {
		return nil, &wsError{message: errMsgChatAccessDenied}
	}

	// Get all member IDs and determine who is offline
	memberIDs, err := h.participantRepo.GetParticipantUserIDs(ctx, chat.ID)
	if err != nil {
		return nil, &wsError{message: "Failed to get group members"}
	}

	var offlineUserIDs []uint
	for _, memberID := range memberIDs {
		if memberID != userID && !h.presenceService.IsUserOnline(memberID) {
			offlineUserIDs = append(offlineUserIDs, memberID)
		}
	}

	msg, err := h.chatService.SendMessageAtomicGroup(ctx, msgData.ChatID, userID, offlineUserIDs, services.SendMessageInput{
		Text:                msgData.Text,
		IV:                  msgData.IV,
		Scheme:              msgData.Scheme,
		ReplyToID:           msgData.ReplyToID,
		ForwardedFromUserID: msgData.ForwardedFromUserID,
		Envelopes:           toServiceEnvelopes(msgData.Envelopes),
	})
	if err != nil {
		h.logger.Error("error sending group message",
			zap.Error(err),
			zap.Uint("user_id", userID),
			zap.Uint("chat_id", msgData.ChatID),
		)
		return nil, &wsError{message: "Failed to send message"}
	}

	// Push notification for each offline group member
	if h.pushService != nil && h.pushService.IsEnabled() {
		pushBody := pushBodyFromMessage(msgData)
		for _, memberID := range offlineUserIDs {
			go h.sendPushNotification(userID, memberID, msgData.ChatID, pushBody)
		}
	}

	return msg, nil
}

// toServiceEnvelopes converts the WS-layer envelope slice into the service-layer
// shape. Returns nil for the empty case so the service can keep its
// "no envelopes == 1-on-1 or scheme=1" branching simple.
func toServiceEnvelopes(in []messageEnvelopeAction) []services.MessageEnvelopeInput {
	if len(in) == 0 {
		return nil
	}
	out := make([]services.MessageEnvelopeInput, len(in))
	for i, e := range in {
		out[i] = services.MessageEnvelopeInput{
			RecipientID: e.RecipientID,
			Ciphertext:  e.Ciphertext,
			IV:          e.IV,
		}
	}
	return out
}

// pushBodyFromMessage decides what goes into the push notification body.
// For server-side encrypted messages we use the plaintext (truncated to 200 chars).
// For client-side encrypted (E2E) messages the server has no plaintext, so we fall
// back to a generic "Новое сообщение" placeholder — peeking inside the ciphertext
// would defeat the whole point of E2E.
func pushBodyFromMessage(msgData messageAction) string {
	if msgData.Scheme == models.SchemeClientSide {
		return i18n.NewMessagePush
	}
	text := msgData.Text
	if runes := []rune(text); len(runes) > 200 {
		text = string(runes[:200]) + "..."
	}
	return text
}

// sendPushNotification sends a push notification to a recipient in a background goroutine.
// Uses context.Background() intentionally: push delivery must not depend on the sender's WebSocket connection.
//
//nolint:contextcheck // intentionally detached from client context
func (h *webSocketHandler) sendPushNotification(senderID, recipientID, chatID uint, text string) {
	defer func() {
		if r := recover(); r != nil {
			h.logger.Error("panic in push notification goroutine",
				zap.Any("panic", r),
				zap.Uint("recipient_id", recipientID),
			)
		}
	}()

	h.logger.Debug("attempting push notification",
		zap.Uint("sender_id", senderID),
		zap.Uint("recipient_id", recipientID),
		zap.Uint("chat_id", chatID),
	)

	senderName := "New message"
	if sender, err := h.userService.GetUserByID(context.Background(), senderID); err == nil {
		senderName = sender.GetDisplayName()
	}

	body := text
	if strings.TrimSpace(body) == "" {
		body = pushBodyAttachmentPlaceholder
	}
	if utf8.RuneCountInString(body) > 200 {
		runes := []rune(body)
		body = string(runes[:200]) + "..."
	}

	payload := services.PushPayload{
		Title:  senderName,
		Body:   body,
		ChatID: chatID,
		UserID: senderID,
		Tag:    fmt.Sprintf("chat-%d", chatID),
	}

	if err := h.pushService.SendNotification(context.Background(), recipientID, payload); err != nil {
		h.logger.Error("failed to send push notification",
			zap.Error(err),
			zap.Uint("recipient_id", recipientID),
		)
	}
}

// handleEditMessage processes a message edit
func (h *webSocketHandler) handleEditMessage(ctx context.Context, userID uint, msgData messageAction) error {
	if msgData.MessageID == 0 {
		return &wsError{message: "Message ID required for edit"}
	}
	if msgData.Scheme != models.SchemeClientSide {
		return &wsError{message: "Client update required: server-side encryption is no longer supported"}
	}
	if len(msgData.Envelopes) == 0 {
		if msgData.Text == "" {
			return &wsError{message: "New message text cannot be empty"}
		}
		if len(msgData.Text) > maxMessageSize {
			return &wsError{message: "Message too large (max 10KB)"}
		}
		if msgData.IV == "" {
			return &wsError{message: "iv is required for client-encrypted edits"}
		}
	}

	// Check access to chat
	if err := h.checkWSChatAccess(ctx, msgData.ChatID, userID); err != nil {
		return err
	}

	if err := h.chatService.EditMessage(ctx, msgData.MessageID, userID, services.SendMessageInput{
		Text:      msgData.Text,
		IV:        msgData.IV,
		Scheme:    msgData.Scheme,
		Envelopes: toServiceEnvelopes(msgData.Envelopes),
	}); err != nil {
		h.logger.Error("error editing message",
			zap.Error(err),
			zap.Uint("message_id", msgData.MessageID),
			zap.Uint("user_id", userID),
		)
		return &wsError{message: "Failed to edit message"}
	}

	broadcastData := map[string]any{
		"action":  "edit",
		"chat_id": msgData.ChatID,
		"id":      msgData.MessageID,
		"text":    msgData.Text,
		"user_id": userID,
	}
	addE2EFieldsToBroadcast(broadcastData, msgData.Scheme, msgData.IV, msgData.Envelopes)
	msgJSON, err := json.Marshal(broadcastData)
	if err != nil {
		h.logger.Error("json marshal error",
			zap.Error(err),
			zap.Uint("message_id", msgData.MessageID),
		)
		return &wsError{message: "Server error"}
	}

	if err := h.broadcastToChat(ctx, msgData.ChatID, msgJSON); err != nil {
		h.logger.Error("failed to broadcast edit",
			zap.Error(err),
			zap.Uint("chat_id", msgData.ChatID),
		)
	}
	return nil
}

// handleDeleteMessage processes a message deletion
func (h *webSocketHandler) handleDeleteMessage(ctx context.Context, userID uint, msgData messageAction) error {
	if msgData.MessageID == 0 {
		return &wsError{message: "Message ID required for delete"}
	}

	// Check access to chat
	if err := h.checkWSChatAccess(ctx, msgData.ChatID, userID); err != nil {
		return err
	}

	if err := h.chatService.DeleteMessage(ctx, msgData.MessageID, userID); err != nil {
		h.logger.Error("error deleting message",
			zap.Error(err),
			zap.Uint("message_id", msgData.MessageID),
			zap.Uint("user_id", userID),
		)
		return &wsError{message: "Failed to delete message"}
	}

	broadcastData := map[string]any{
		"action":     "delete",
		"chat_id":    msgData.ChatID,
		"id":         msgData.MessageID,
		"user_id":    userID,
		"is_deleted": true,
	}
	msgJSON, err := json.Marshal(broadcastData)
	if err != nil {
		h.logger.Error("json marshal error",
			zap.Error(err),
			zap.Uint("message_id", msgData.MessageID),
		)
		return &wsError{message: "Server error"}
	}

	if err := h.broadcastToChat(ctx, msgData.ChatID, msgJSON); err != nil {
		h.logger.Error("failed to broadcast delete",
			zap.Error(err),
			zap.Uint("chat_id", msgData.ChatID),
		)
	}

	// After delete: any recipient whose unread for this chat dropped to zero
	// shouldn't keep seeing a tray notification for it. Per-recipient check
	// because the deleted message may not have been the LAST unread for
	// everyone — only those who hit zero get the dismiss. Sender is included
	// in the sweep (their unread state is unchanged by deleting their own
	// message, so the EXISTS check skips them in practice).
	//
	// Detached goroutine: for a 50-member group this is 50 sync EXISTS
	// round-trips (~50-100ms total). We don't want to block the WS read
	// loop on push housekeeping — the broadcast above already informed
	// peers, dismiss is best-effort tray cleanup.
	go h.fanoutDismissAfterUnreadChange(context.Background(), msgData.ChatID) //nolint:contextcheck // detached on purpose
	return nil
}

// handleMarkRead marks messages as read
func (h *webSocketHandler) handleMarkRead(ctx context.Context, userID uint, msgData messageAction) error {
	if msgData.ChatID == 0 {
		return &wsError{message: "chat_id is required"}
	}

	// Delete all unread messages for this user in this chat
	if err := h.chatService.MarkChatAsRead(ctx, userID, msgData.ChatID); err != nil {
		h.logger.Error("failed to mark messages as read",
			zap.Error(err),
			zap.Uint("user_id", userID),
			zap.Uint("chat_id", msgData.ChatID),
		)
		return &wsError{message: "Failed to mark messages as read"}
	}

	// User's unread for this chat is now empty (MarkChatAsRead wiped it);
	// dismiss any push notifications still sitting on their other devices.
	h.fireDismissPush(ctx, userID, msgData.ChatID)

	// Read receipt (1-on-1 only for v1): advance the durable read pointer and
	// notify the message author so their sent bubbles flip to ✓✓ (read). The
	// client sends up_to_message_id = highest message it has read.
	if msgData.UpToMessageID > 0 {
		h.recordReadReceipt(ctx, userID, msgData.ChatID, msgData.UpToMessageID)
	}

	return nil
}

// recordReadReceipt advances userID's read pointer in a 1-on-1 chat and notifies
// the message author (✓✓ read). Best-effort and 1-on-1 only — a no-op for groups
// or on any error, so it never fails the mark_read it's called from.
func (h *webSocketHandler) recordReadReceipt(ctx context.Context, userID, chatID, upToMessageID uint) {
	chat, err := h.chatService.FindChatByIDLight(ctx, chatID)
	if err != nil || chat.IsGroup {
		return
	}
	if err := h.chatService.MarkReadReceipt(ctx, chatID, userID, upToMessageID); err != nil {
		h.logger.Warn("failed to upsert read receipt",
			zap.Error(err),
			zap.Uint("user_id", userID),
			zap.Uint("chat_id", chatID),
		)
		return
	}
	h.emitMessageStatus(ctx, chat, userID, "read", upToMessageID)
}

// handleMarkDelivered records that userID received messages up to MessageID in
// the chat and notifies the message author so their sent bubbles flip to ✓✓
// (delivered). 1-on-1 only for v1 — group receipts would need per-recipient
// aggregation before a sender could show a single delivered/read state.
func (h *webSocketHandler) handleMarkDelivered(ctx context.Context, userID uint, msgData messageAction) error {
	if msgData.ChatID == 0 || msgData.MessageID == 0 {
		return &wsError{message: "chat_id and message_id are required"}
	}
	// Access guard: the caller must be a participant. Also prevents a malicious
	// client from probing arbitrary chat_ids.
	if err := h.checkWSChatAccess(ctx, msgData.ChatID, userID); err != nil {
		return err
	}
	chat, err := h.chatService.FindChatByIDLight(ctx, msgData.ChatID)
	if err != nil {
		return &wsError{message: "chat not found"}
	}
	if chat.IsGroup {
		return nil // v1: no group receipts
	}
	if err := h.chatService.MarkDelivered(ctx, msgData.ChatID, userID, msgData.MessageID); err != nil {
		h.logger.Warn("failed to upsert delivered receipt",
			zap.Error(err),
			zap.Uint("user_id", userID),
			zap.Uint("chat_id", msgData.ChatID),
		)
		return nil // best-effort
	}
	h.emitMessageStatus(ctx, chat, userID, "delivered", msgData.MessageID)
	return nil
}

// emitMessageStatus notifies the *other* party in a 1-on-1 chat that actorID has
// delivered/read messages up to upToMessageID. Routed only to the peer (the
// message author) via broadcastToUser, which is best-effort — if the author has
// no live socket the update is simply re-derived on their next chat open from
// the persisted receipt. Gated to 1-on-1 for v1.
func (h *webSocketHandler) emitMessageStatus(ctx context.Context, chat *models.Chat, actorID uint, status string, upToMessageID uint) {
	if chat.IsGroup {
		return
	}
	payload := map[string]interface{}{
		"action":           "message_status",
		"chat_id":          chat.ID,
		"user_id":          actorID,
		"status":           status,
		"up_to_message_id": upToMessageID,
	}
	msgJSON, err := json.Marshal(payload)
	if err != nil {
		h.logger.Error("failed to marshal message_status", zap.Error(err))
		return
	}
	for _, recipientID := range h.getChatRecipients(ctx, chat, actorID) {
		if h.presenceService.IsUserOnline(recipientID) {
			h.broadcastToUser(recipientID, msgJSON)
		}
	}
}

// handleChatOpened is the "I'm in this chat right now" signal — fires when
// the frontend mounts a chat view. Doesn't mutate unread state; just clears
// the user's push notifications for that chat from every device they have.
// Covers the "tapped notification but didn't actually read anything" case
// the mark_read-based dismiss would otherwise miss.
//
// Access-checked even though the dismiss is targeted at the caller's own
// subscriptions — otherwise a malicious WS client could send arbitrary
// chat_ids and amplify each WS frame into one outbound HTTP per push API
// (web + FCM). Cheap DoS-amplification vector; gated by membership check.
func (h *webSocketHandler) handleChatOpened(ctx context.Context, userID uint, msgData messageAction) error {
	if msgData.ChatID == 0 {
		return &wsError{message: "chat_id is required"}
	}
	if err := h.checkWSChatAccess(ctx, msgData.ChatID, userID); err != nil {
		return err
	}
	h.fireDismissPush(ctx, userID, msgData.ChatID)
	return nil
}

// fireDismissPush kicks off a background dismiss push to the user's other
// devices. Unconditional — callers have already established that this user
// should not be seeing a notification for this chat anymore (either by
// emptying their unread, or by entering the chat). Idempotent on the
// receiver: getNotifications + close is a no-op when nothing matches.
//
// Accepts the caller's ctx for contextcheck-lint satisfaction but the actual
// HTTP call uses context.Background() — push delivery must not be canceled
// when the originating WS frame finishes processing.
func (h *webSocketHandler) fireDismissPush(_ context.Context, userID, chatID uint) {
	if h.pushService == nil || !h.pushService.IsEnabled() {
		return
	}
	go func() { //nolint:contextcheck // intentionally detached — see comment above
		defer func() {
			if r := recover(); r != nil {
				h.logger.Error("panic in dismiss-push goroutine", zap.Any("panic", r))
			}
		}()
		if err := h.pushService.SendDismiss(context.Background(), userID, chatID); err != nil {
			h.logger.Warn("dismiss push failed",
				zap.Error(err),
				zap.Uint("user_id", userID),
				zap.Uint("chat_id", chatID),
			)
		}
	}()
}

// fireDismissPushIfRead is the per-recipient version: only dispatches if
// recipientID's unread for chatID has actually hit zero. Used after
// delete_message and clear_chat where we don't know in advance which
// recipients lost their last unread.
func (h *webSocketHandler) fireDismissPushIfRead(ctx context.Context, recipientID, chatID uint) {
	if h.pushService == nil || !h.pushService.IsEnabled() {
		return
	}
	if h.unreadMessageRepo == nil {
		return
	}
	has, err := h.unreadMessageRepo.HasUnreadInChat(ctx, recipientID, chatID)
	if err != nil {
		h.logger.Warn("unread check failed for dismiss",
			zap.Error(err),
			zap.Uint("user_id", recipientID),
			zap.Uint("chat_id", chatID),
		)
		return
	}
	if has {
		return
	}
	h.fireDismissPush(ctx, recipientID, chatID)
}

// fanoutDismissAfterUnreadChange iterates every participant of chatID and
// fires a per-recipient dismiss-if-read check. Used after operations that
// can drop someone's unread count to zero in bulk (delete_message). For
// 1-on-1 chats this is exactly 2 cheap EXISTS queries; for max-50-member
// groups it's 50 — still trivial. The fire-and-forget dismiss inside
// fireDismissPushIfRead spins its own goroutine so a slow push provider
// can't back up the WS handler.
func (h *webSocketHandler) fanoutDismissAfterUnreadChange(ctx context.Context, chatID uint) {
	if h.pushService == nil || !h.pushService.IsEnabled() {
		return
	}
	chat, err := h.chatService.FindChatByIDLight(ctx, chatID)
	if err != nil {
		h.logger.Warn("fanout dismiss: chat lookup failed", zap.Error(err), zap.Uint("chat_id", chatID))
		return
	}
	var memberIDs []uint
	if chat.IsGroup {
		if h.participantRepo == nil {
			return
		}
		ids, perr := h.participantRepo.GetParticipantUserIDs(ctx, chatID)
		if perr != nil {
			h.logger.Warn("fanout dismiss: participants lookup failed", zap.Error(perr))
			return
		}
		memberIDs = ids
	} else {
		memberIDs = []uint{chat.GetUser1ID(), chat.GetUser2ID()}
	}
	for _, uid := range memberIDs {
		if uid == 0 {
			continue
		}
		h.fireDismissPushIfRead(ctx, uid, chatID)
	}
}

// dismissForParticipants is the unconditional version used for chat-level
// destructive ops (clear / delete) where we know every participant's unread
// for the chat just got wiped. participantIDs is captured by the caller
// BEFORE the destructive op so DeleteChat's row removal doesn't strand the
// lookup. Fire unconditional dismiss — no EXISTS check, the row count is
// guaranteed zero post-op.
func (h *webSocketHandler) dismissForParticipants(ctx context.Context, chatID uint, participantIDs []uint) {
	if h.pushService == nil || !h.pushService.IsEnabled() {
		return
	}
	for _, uid := range participantIDs {
		if uid == 0 {
			continue
		}
		h.fireDismissPush(ctx, uid, chatID)
	}
}

// checkWSChatAccess verifies the user has access to the chat (1-on-1 or group).
func (h *webSocketHandler) checkWSChatAccess(ctx context.Context, chatID, userID uint) error {
	chat, err := h.chatService.FindChatByIDLight(ctx, chatID)
	if err != nil {
		return &wsError{message: errMsgChatAccessDenied}
	}

	if chat.IsGroup {
		if h.participantRepo == nil {
			return &wsError{message: "Group chat not supported"}
		}
		if _, err := h.participantRepo.FindByUserAndChat(ctx, chatID, userID); err != nil {
			return &wsError{message: errMsgChatAccessDenied}
		}
		return nil
	}

	if !chat.HasUser(userID) {
		return &wsError{message: errMsgChatAccessDenied}
	}
	return nil
}
