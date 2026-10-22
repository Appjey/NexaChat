package handlers

import (
	"context"
	"encoding/json"
	"time"

	"messenger/internal/models"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// broadcastToUser sends a message to all connections of a specific user.
// A snapshot of the client slice is taken under RLock to avoid racing with removeClient.
func (h *webSocketHandler) broadcastToUser(userID uint, msgJSON []byte) {
	h.mu.RLock()
	src := h.clients[userID]
	clientsToSend := make([]*wsClient, len(src))
	copy(clientsToSend, src)
	h.mu.RUnlock()

	for _, client := range clientsToSend {
		c := client // Capture for closure
		h.broadcastPool.Submit(func() {
			defer func() {
				if r := recover(); r != nil {
					h.logger.Error("panic in broadcast",
						zap.Any("panic", r),
						zap.Uint("user_id", userID),
					)
				}
			}()

			// Protect writes with mutex (Gorilla WebSocket not thread-safe)
			c.writeMu.Lock()
			defer c.writeMu.Unlock()

			if err := c.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				h.logger.Warn("failed to set write deadline",
					zap.Error(err),
					zap.Uint("user_id", userID),
				)
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msgJSON); err != nil {
				h.logger.Error("websocket write error",
					zap.Error(err),
					zap.Uint("user_id", userID),
				)
			}
		})
	}
}

// broadcastToChat sends a message to all participants in a chat (1-on-1 or group)
func (h *webSocketHandler) broadcastToChat(ctx context.Context, chatID uint, msgJSON []byte, excludeUserID ...uint) error {
	chat, err := h.chatService.FindChatByIDLight(ctx, chatID)
	if err != nil {
		return err
	}

	var participants []uint
	if chat.IsGroup && h.participantRepo != nil {
		participants, err = h.participantRepo.GetParticipantUserIDs(ctx, chatID)
		if err != nil {
			return err
		}
	} else {
		participants = []uint{chat.GetUser1ID(), chat.GetUser2ID()}
	}

	for _, userID := range participants {
		skip := false
		for _, excludeID := range excludeUserID {
			if userID == excludeID {
				skip = true
				break
			}
		}
		if skip {
			continue
		}

		if h.presenceService.IsUserOnline(userID) {
			h.broadcastToUser(userID, msgJSON)
		}
	}

	return nil
}

// getChatRecipients returns the list of user IDs that should receive a message for the given chat,
// excluding the specified user. For group chats it returns all participants except excludeUserID;
// for 1-on-1 chats it returns the other user.
func (h *webSocketHandler) getChatRecipients(ctx context.Context, chat *models.Chat, excludeUserID uint) []uint {
	if chat.IsGroup && h.participantRepo != nil {
		memberIDs, err := h.participantRepo.GetParticipantUserIDs(ctx, chat.ID)
		if err != nil {
			return nil
		}
		recipients := make([]uint, 0, len(memberIDs))
		for _, id := range memberIDs {
			if id != excludeUserID {
				recipients = append(recipients, id)
			}
		}
		return recipients
	}

	otherUserID := chat.GetUser1ID()
	if chat.GetUser1ID() == excludeUserID {
		otherUserID = chat.GetUser2ID()
	}
	return []uint{otherUserID}
}

// broadcastPresenceChange notifies all chat participants about a user's online status change
func (h *webSocketHandler) broadcastPresenceChange(userID uint, isOnline bool) {
	ctx := context.Background()

	// LastSeen as tracked in-memory: the disconnect moment for a graceful drop, or
	// the last heartbeat for a cleanup-driven timeout. Either way it's the right
	// "last seen" value to show and persist.
	lastSeen := h.presenceService.GetUserStatus(userID).LastSeen

	// Persist last-seen on the offline transition so it survives a restart or the
	// 1-hour presence eviction. Best-effort — a failed write just means the header
	// falls back to "Не в сети" until the next offline transition.
	if !isOnline && h.userService != nil && !lastSeen.IsZero() {
		if err := h.userService.UpdateLastSeen(ctx, userID, lastSeen); err != nil {
			h.logger.Warn("failed to persist last seen",
				zap.Error(err),
				zap.Uint("user_id", userID),
			)
		}
	}

	chats, err := h.chatService.GetUserChats(ctx, userID, false)
	if err != nil {
		h.logger.Error("failed to get chats for presence broadcast",
			zap.Error(err),
			zap.Uint("user_id", userID),
		)
		return
	}

	presenceData := map[string]any{
		"action":    "presence_changed",
		"user_id":   userID,
		"is_online": isOnline,
		"last_seen": lastSeen.Format(time.RFC3339),
	}
	msgJSON, err := json.Marshal(presenceData)
	if err != nil {
		h.logger.Error("failed to marshal presence event",
			zap.Error(err),
			zap.Uint("user_id", userID),
		)
		return
	}

	notifiedUsers := make(map[uint]bool)
	for _, chat := range chats {
		recipients := h.getChatRecipients(ctx, &chat, userID)
		for _, recipientID := range recipients {
			if notifiedUsers[recipientID] {
				continue
			}
			notifiedUsers[recipientID] = true
			if h.presenceService.IsUserOnline(recipientID) {
				h.broadcastToUser(recipientID, msgJSON)
			}
		}
	}

	h.logger.Info("broadcasted presence change",
		zap.Uint("user_id", userID),
		zap.Bool("is_online", isOnline),
		zap.Int("notified_users", len(notifiedUsers)),
	)
}

// broadcastChatEvent notifies chat participants about chat-level operations (clear/delete).
// Called from chatHandler via callback before the destructive DB operation executes.
func (h *webSocketHandler) broadcastChatEvent(chatID, initiatorUserID uint, action string) {
	ctx := context.Background()

	chat, err := h.chatService.FindChatByIDLight(ctx, chatID)
	if err != nil {
		h.logger.Error("failed to find chat for event broadcast",
			zap.Error(err),
			zap.Uint("chat_id", chatID),
			zap.String("action", action),
		)
		return
	}

	eventData := map[string]any{
		"action":  action,
		"chat_id": chatID,
		"user_id": initiatorUserID,
	}
	msgJSON, err := json.Marshal(eventData)
	if err != nil {
		h.logger.Error("failed to marshal chat event",
			zap.Error(err),
			zap.Uint("chat_id", chatID),
		)
		return
	}

	recipients := h.getChatRecipients(ctx, chat, initiatorUserID)
	for _, recipientID := range recipients {
		if h.presenceService.IsUserOnline(recipientID) {
			h.broadcastToUser(recipientID, msgJSON)
		}
	}

	h.logger.Info("broadcasted chat event",
		zap.String("action", action),
		zap.Uint("chat_id", chatID),
		zap.Uint("initiator", initiatorUserID),
	)
}

// broadcastGroupEvent broadcasts group-specific events (member changes, updates) to all group participants.
// Called from groupHandler via callback.
func (h *webSocketHandler) broadcastGroupEvent(event groupEvent) {
	ctx := context.Background()

	if h.participantRepo == nil {
		return
	}

	memberIDs, err := h.participantRepo.GetParticipantUserIDs(ctx, event.ChatID)
	if err != nil {
		h.logger.Error("failed to get group members for group event",
			zap.Error(err),
			zap.Uint("chat_id", event.ChatID),
			zap.String("action", event.Action),
		)
		return
	}

	eventData := map[string]any{
		"action":  event.Action,
		"chat_id": event.ChatID,
	}
	if event.ActorID != 0 {
		eventData["actor_id"] = event.ActorID
	}
	if event.UserID != 0 {
		eventData["user_id"] = event.UserID
	}
	if len(event.Members) > 0 {
		eventData["members"] = event.Members
	}
	if event.Name != "" {
		eventData["name"] = event.Name
	}
	if event.Avatar != "" {
		eventData["avatar_url"] = event.Avatar
	}
	if event.NewRole != "" {
		eventData["new_role"] = event.NewRole
	}

	msgJSON, err := json.Marshal(eventData)
	if err != nil {
		h.logger.Error("failed to marshal group event",
			zap.Error(err),
			zap.Uint("chat_id", event.ChatID),
		)
		return
	}

	for _, memberID := range memberIDs {
		if h.presenceService.IsUserOnline(memberID) {
			h.broadcastToUser(memberID, msgJSON)
		}
	}

	// For member_added, also notify the newly added members (they might not be in participant list yet
	// if the broadcast happens before DB commit, but in our case broadcast is after AddMembers)
	if event.Action == "member_added" {
		for _, member := range event.Members {
			alreadyNotified := false
			for _, id := range memberIDs {
				if id == member.UserID {
					alreadyNotified = true
					break
				}
			}
			if !alreadyNotified && h.presenceService.IsUserOnline(member.UserID) {
				h.broadcastToUser(member.UserID, msgJSON)
			}
		}
	}

	h.logger.Info("broadcasted group event",
		zap.String("action", event.Action),
		zap.Uint("chat_id", event.ChatID),
		zap.Int("recipients", len(memberIDs)),
	)
}

// broadcastPinEvent notifies all chat participants about a pin/unpin event.
// Called from pinHandler via callback.
func (h *webSocketHandler) broadcastPinEvent(chatID, messageID uint, action string) {
	ctx := context.Background()

	eventData := map[string]any{
		"action":     action,
		"chat_id":    chatID,
		"message_id": messageID,
	}
	msgJSON, err := json.Marshal(eventData)
	if err != nil {
		h.logger.Error("failed to marshal pin event",
			zap.Error(err),
			zap.Uint("chat_id", chatID),
		)
		return
	}

	if err := h.broadcastToChat(ctx, chatID, msgJSON); err != nil {
		h.logger.Error("failed to broadcast pin event",
			zap.Error(err),
			zap.Uint("chat_id", chatID),
		)
	}
}

// sendPendingMessages sends all unread messages to a newly connected user.
// Slightly over the funlen threshold (~125 lines) because the per-message
// loop bundles five orthogonal steps (envelope resolution, scheme=2 skip,
// attachment serialization, JSON marshal, WS write with mutex) — splitting
// makes the cleanup of error paths much fiddlier.
//
//nolint:funlen // see comment above
func (h *webSocketHandler) sendPendingMessages(client *wsClient, userID uint) {
	unreadMessages, err := h.chatService.GetUnreadMessagesForUser(client.ctx, userID)
	if err != nil {
		h.logger.Error("failed to get pending messages",
			zap.Error(err),
			zap.Uint("user_id", userID),
		)
		return
	}

	if len(unreadMessages) == 0 {
		h.logger.Info("no pending messages for user",
			zap.Uint("user_id", userID),
		)
		return
	}

	h.logger.Info("sending pending messages to user",
		zap.Uint("user_id", userID),
		zap.Int("count", len(unreadMessages)),
	)

	// Send each unread message to the client
	for _, unread := range unreadMessages {
		if unread.Message.ID == 0 {
			continue
		}

		replyToIDVal := uint(0)
		if unread.Message.ReplyToID != nil {
			replyToIDVal = *unread.Message.ReplyToID
		}
		forwardedFromVal := uint(0)
		if unread.Message.ForwardedFromUserID != nil {
			forwardedFromVal = *unread.Message.ForwardedFromUserID
		}

		// For group scheme=2 messages the row carries no ciphertext — we need to
		// substitute the envelope addressed to this user. If there's no envelope
		// (user joined the group after the message was sent), skip the replay
		// entirely so we don't broadcast an empty bubble.
		msgCopy := unread.Message
		if msgCopy.Scheme == models.SchemeClientSide && msgCopy.Text == "" && msgCopy.IV == "" {
			applied, err := h.chatService.FillEnvelopeForUser(client.ctx, &msgCopy, userID)
			if err != nil {
				h.logger.Warn("failed to resolve envelope for pending message",
					zap.Error(err),
					zap.Uint("message_id", msgCopy.ID),
					zap.Uint("user_id", userID),
				)
				continue
			}
			if !applied {
				continue
			}
		}

		// scheme=2 messages are forwarded with their ciphertext + IV intact and
		// the receiving client decrypts locally. Legacy scheme=1 rows can't be
		// decrypted on the server anymore — skip the replay so the client
		// doesn't try to render an unreadable bubble.
		if msgCopy.Scheme != models.SchemeClientSide {
			continue
		}
		text := msgCopy.Text

		// Serialize attachments for the broadcast (with presigned URLs + the
		// recipient's per-user envelope so client can decrypt).
		var attachmentsList []map[string]any
		if h.fileStorage != nil && h.attachmentService != nil {
			attachmentsList = serializeAttachmentSliceForUser(client.ctx, h.attachmentService, msgCopy.Attachments, userID, h.fileStorage)
		} else if h.fileStorage != nil {
			attachmentsList = serializeAttachmentSlice(msgCopy.Attachments, h.fileStorage)
		}

		broadcastData := map[string]any{
			"action":                 "new",
			"chat_id":                unread.ChatID,
			"user_id":                msgCopy.UserID,
			"text":                   text,
			"type":                   string(msgCopy.Type),
			"reply_to_id":            replyToIDVal,
			"forwarded_from_user_id": forwardedFromVal,
			"id":                     msgCopy.ID,
			"created_at":             msgCopy.CreatedAt,
			"is_deleted":             msgCopy.IsDeleted,
			"attachments":            attachmentsList,
			// Mark as an offline-replay so the client doesn't re-increment the
			// unread badge: loadChats already reflects these via the server's
			// unread_count, and bumping again here double-counts them.
			"replayed": true,
		}
		// Replay treats the resolved-envelope form as a 1-on-1-shaped scheme=2
		// payload (text + iv populated, no envelopes array) — receiving client
		// decrypts with deriveChatKey(self, sender.public) regardless of chat type.
		addE2EFieldsToBroadcast(broadcastData, msgCopy.Scheme, msgCopy.IV, nil)

		msgJSON, err := json.Marshal(broadcastData)
		if err != nil {
			h.logger.Error("failed to marshal pending message",
				zap.Error(err),
				zap.Uint("message_id", unread.MessageID),
			)
			continue
		}

		// Protect writes with mutex (Gorilla WebSocket not thread-safe)
		client.writeMu.Lock()
		if err := client.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
			h.logger.Warn("failed to set write deadline for pending message",
				zap.Error(err),
				zap.Uint("user_id", userID),
			)
			client.writeMu.Unlock()
			continue
		}
		if err := client.conn.WriteMessage(websocket.TextMessage, msgJSON); err != nil {
			h.logger.Error("failed to send pending message",
				zap.Error(err),
				zap.Uint("user_id", userID),
				zap.Uint("message_id", unread.MessageID),
			)
			// Don't return on error, try to send remaining messages
		}
		client.writeMu.Unlock()
	}

	// Clean up delivered unread records so they aren't re-sent on next reconnect
	if err := h.chatService.DeleteUnreadForUser(client.ctx, userID); err != nil {
		h.logger.Error("failed to delete delivered unread messages",
			zap.Error(err),
			zap.Uint("user_id", userID),
		)
	}
}

// BroadcastAttachmentsAdded notifies all chat participants that attachments were added to a message.
// Called from attachmentHandler after successful upload.
func (h *webSocketHandler) BroadcastAttachmentsAdded(chatID, messageID uint, attachments []map[string]any) {
	ctx := context.Background()

	broadcastData := map[string]any{
		"action":      "attachments_added",
		"chat_id":     chatID,
		"message_id":  messageID,
		"attachments": attachments,
	}

	msgJSON, err := json.Marshal(broadcastData)
	if err != nil {
		h.logger.Error("failed to marshal attachments_added event",
			zap.Error(err),
			zap.Uint("chat_id", chatID),
			zap.Uint("message_id", messageID),
		)
		return
	}

	if err := h.broadcastToChat(ctx, chatID, msgJSON); err != nil {
		h.logger.Error("failed to broadcast attachments_added",
			zap.Error(err),
			zap.Uint("chat_id", chatID),
		)
	}
}
