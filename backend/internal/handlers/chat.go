package handlers

import (
	"context"
	"sort"
	"time"

	"messenger/internal/i18n"
	"messenger/internal/models"
	"messenger/internal/services"
	"messenger/internal/storage"

	"github.com/gin-gonic/gin"
)

// chatHandler handles HTTP API endpoints for chats.
type chatHandler struct {
	chatService       *services.ChatService
	userService       *services.UserService
	groupService      *services.GroupService
	attachmentService *services.AttachmentService
	storage           storage.Storage
	onChatEvent       func(chatID, initiatorUserID uint, action string)
	// onUnreadDrained fires after a destructive chat-level action (clear /
	// delete) successfully wipes every recipient's unread for the chat —
	// hooked by webSocketHandler to fan out dismiss-pushes across each
	// participant's devices. Called from chatAction once the destructive
	// DB op returns nil. participantIDs is captured BEFORE the destructive
	// op (DeleteChat removes the row, so a post-op lookup would 404), and
	// the dismiss is unconditional (we know unread was wiped, no EXISTS
	// check needed).
	onUnreadDrained func(ctx context.Context, chatID uint, participantIDs []uint)
}

// SetAttachmentService injects the attachment service so message-list responses
// can pre-resolve the caller's per-user envelope (file_key wrapped under their
// chat_key) without an extra round-trip.
func (h *chatHandler) SetAttachmentService(as *services.AttachmentService) {
	h.attachmentService = as
}

// SetOnChatEventCallback registers a callback for chat-level events (clear/delete).
// Called by webSocketHandler to enable real-time sync between participants.
func (h *chatHandler) SetOnChatEventCallback(cb func(chatID, initiatorUserID uint, action string)) {
	h.onChatEvent = cb
}

// SetOnUnreadDrainedCallback registers a callback that fires after a chat-level
// destructive op (clear / delete) succeeds. Wired to webSocketHandler's
// dismissForParticipants so notification trays clear on every participant's
// other devices.
func (h *chatHandler) SetOnUnreadDrainedCallback(cb func(ctx context.Context, chatID uint, participantIDs []uint)) {
	h.onUnreadDrained = cb
}

// SetGroupService sets the group service for group chat support in chat handlers.
func (h *chatHandler) SetGroupService(gs *services.GroupService) {
	h.groupService = gs
}

// newChatHandler creates a new chatHandler.
func newChatHandler(
	chatService *services.ChatService,
	userService *services.UserService,
	fileStorage storage.Storage,
) *chatHandler {
	return &chatHandler{
		chatService: chatService,
		userService: userService,
		storage:     fileStorage,
	}
}

type attachmentResponse struct {
	ID       uint   `json:"id"`
	FileSize int64  `json:"file_size"`
	URL      string `json:"url"`
	// E2E fields. EncryptedFileKey + EnvelopeIV are pre-resolved server-side
	// for the requesting user via attachment_envelopes (per-recipient wrapped
	// file_key). FileIV is the body's own AES-GCM nonce, identical across
	// recipients. EncryptedMetadata + MetadataIV wrap {fileName, mimeType}
	// under the same file_key — server never sees the plaintext, and after
	// the legacy-column removal those values exist nowhere else.
	EncryptedFileKey  string `json:"encrypted_file_key,omitempty"`
	EnvelopeIV        string `json:"envelope_iv,omitempty"`
	FileIV            string `json:"file_iv"`
	EncryptedMetadata string `json:"encrypted_metadata"`
	MetadataIV        string `json:"metadata_iv"`
}

type messageResponse struct {
	ID                  uint                 `json:"id"`
	ChatID              uint                 `json:"chat_id"`
	UserID              uint                 `json:"user_id"`
	Text                string               `json:"text"`
	Type                string               `json:"type"`
	IsDeleted           bool                 `json:"is_deleted"`
	CreatedAt           time.Time            `json:"created_at"`
	ReplyToID           *uint                `json:"reply_to_id"`
	ForwardedFromUserID *uint                `json:"forwarded_from_user_id"`
	EditedAt            *time.Time           `json:"edited_at"`
	Attachments         []attachmentResponse `json:"attachments"`
	// Scheme + IV are emitted only for client-side encrypted messages (scheme=2).
	// Legacy scheme=1 rows keep the previous JSON shape so existing clients keep
	// working unchanged.
	Scheme uint8  `json:"scheme,omitempty"`
	IV     string `json:"iv,omitempty"`
}

// toMessageResponses builds the JSON shape returned by the chat-data / messages
// endpoints. `userID` is the *requesting* user — used to pre-resolve their
// per-recipient attachment envelopes (wrapped file_key + iv) so the client
// gets exactly what it needs to decrypt without an extra round-trip.
func (h *chatHandler) toMessageResponses(ctx context.Context, messages []models.Message, userID uint) []messageResponse {
	// Collect every attachment_id across the slice so we can resolve their
	// envelopes for `userID` in a single bulk lookup.
	var allAttachmentIDs []uint
	for i := range messages {
		for j := range messages[i].Attachments {
			allAttachmentIDs = append(allAttachmentIDs, messages[i].Attachments[j].ID)
		}
	}
	envelopes := map[uint]models.AttachmentEnvelope{}
	if h.attachmentService != nil && len(allAttachmentIDs) > 0 {
		resolved, envErr := h.attachmentService.ResolveAttachmentEnvelopes(ctx, userID, allAttachmentIDs)
		if envErr == nil {
			envelopes = resolved
		}
		// On error: envelopes stays empty → client renders "🔒 placeholder".
	}

	result := make([]messageResponse, 0, len(messages))
	for _, msg := range messages {
		msgType := string(msg.Type)
		if msgType == "" {
			msgType = "user"
		}

		atts := make([]attachmentResponse, 0, len(msg.Attachments))
		for _, att := range msg.Attachments {
			ar := attachmentResponse{
				ID:                att.ID,
				FileSize:          att.FileSize,
				URL:               h.storage.GetURL(att.StorageKey),
				FileIV:            att.FileIV,
				EncryptedMetadata: att.EncryptedMetadata,
				MetadataIV:        att.MetadataIV,
			}
			if env, ok := envelopes[att.ID]; ok {
				ar.EncryptedFileKey = env.EncryptedFileKey
				ar.EnvelopeIV = env.IV
			}
			atts = append(atts, ar)
		}

		out := messageResponse{
			ID:                  msg.ID,
			ChatID:              msg.ChatID,
			UserID:              msg.UserID,
			Text:                msg.Text,
			Type:                msgType,
			ReplyToID:           msg.ReplyToID,
			ForwardedFromUserID: msg.ForwardedFromUserID,
			EditedAt:            msg.EditedAt,
			IsDeleted:           msg.IsDeleted,
			CreatedAt:           msg.CreatedAt,
			Attachments:         atts,
		}
		// For client-side encrypted (E2E) messages, ChatService leaves IV populated
		// because the server can't decrypt. Propagate both scheme + IV so the
		// receiving client can decrypt locally.
		if msg.Scheme == models.SchemeClientSide {
			out.Scheme = msg.Scheme
			out.IV = msg.IV
		}
		result = append(result, out)
	}
	return result
}

// getGroupMemberCount returns the number of members in a group (0 if unavailable).
func (h *chatHandler) getGroupMemberCount(ctx context.Context, chatID uint) int {
	if h.groupService == nil {
		return 0
	}
	members, err := h.groupService.GetGroupMembers(ctx, chatID)
	if err != nil {
		return 0
	}
	return len(members)
}

// getGroupAvatarURL returns a refreshed avatar URL for the group (nil if unset).
func (h *chatHandler) getGroupAvatarURL(chat *models.Chat) *string {
	if chat.AvatarURL != nil && *chat.AvatarURL != "" {
		return h.userService.GetAvatarURL(chat.AvatarURL)
	}
	return nil
}

// getParticipantCount returns the participant count for a group (0 if unavailable).
func (h *chatHandler) getParticipantCount(ctx context.Context, chatID uint) int {
	if h.groupService == nil {
		return 0
	}
	ids, err := h.groupService.GetParticipantUserIDs(ctx, chatID)
	if err != nil {
		return 0
	}
	return len(ids)
}

// buildGroupListItem creates a chatListItem for a group chat. The last-message
// E2E metadata is pre-resolved for the caller's user (per-user envelope picked
// in GetLastMessageForChat) — the client decrypts via ECDH(self, sender.public).
func (h *chatHandler) buildGroupListItem(ctx context.Context, chat *models.Chat, lastMessage string, unreadCounts map[uint]int64, lmScheme uint8, lmCT, lmIV string, lmSenderID uint) chatListItem {
	return chatListItem{
		ID:                    chat.ID,
		IsGroup:               true,
		GroupName:             chat.GetGroupName(),
		MemberCount:           h.getParticipantCount(ctx, chat.ID),
		AvatarURL:             h.getGroupAvatarURL(chat),
		LastMessage:           lastMessage,
		LastMessageScheme:     lmScheme,
		LastMessageCiphertext: lmCT,
		LastMessageIV:         lmIV,
		LastMessageSenderID:   lmSenderID,
		UnreadCount:           int(unreadCounts[chat.ID]),
		UpdatedAt:             chat.UpdatedAt,
	}
}

// checkGroupAccess verifies the user is a member of the group chat.
// Returns nil on success, or responds with an appropriate error and returns a non-nil error.
func (h *chatHandler) checkGroupAccess(c *gin.Context, chatID, userID uint) error {
	if h.groupService == nil {
		sendInternalError(c, "Group service unavailable")
		return errAccessDenied
	}
	inGroup, err := h.groupService.IsUserInGroup(c.Request.Context(), chatID, userID)
	if err != nil {
		sendInternalError(c, "Failed to check group membership")
		return err
	}
	if !inGroup {
		sendForbidden(c, "Access denied")
		return errAccessDenied
	}
	return nil
}

// checkChatAccess verifies the user has access to the chat (group or 1-on-1).
func (h *chatHandler) checkChatAccess(c *gin.Context, chat *models.Chat, userID uint) error {
	if chat.IsGroup {
		return h.checkGroupAccess(c, chat.ID, userID)
	}
	if !chat.HasUser(userID) {
		sendForbidden(c, "Access denied")
		return errAccessDenied
	}
	return nil
}

// formatLastMessage extracts display text from the last non-deleted message in a chat.
// Deleted messages are filtered out upstream (see ChatService.GetLastMessageForChat), so we don't
// need a "deleted" fallback here — an empty chat simply renders no preview.
//
// For scheme=2 (client-side encrypted) messages the server can't decrypt the text, so
// the preview becomes a generic placeholder instead of leaking ciphertext into the
// chat-list UI. Clients can do their own ECDH decrypt to show the real preview if
// they want; this fallback is what gets rendered when the client doesn't bother.
func formatLastMessage(lastMsg *models.Message, err error) string {
	if err != nil || lastMsg == nil {
		return ""
	}

	if lastMsg.Scheme == models.SchemeClientSide {
		// Server can't decrypt scheme=2 text. If the message carries files, hint
		// that with a generic attachment label instead of the lock placeholder;
		// the client overrides it with the decrypted text when there is text.
		if len(lastMsg.Attachments) > 0 {
			return i18n.AttachmentPlaceholder
		}
		return i18n.EncryptedPlaceholder
	}

	text := lastMsg.Text
	if runes := []rune(text); len(runes) > maxChatListPreview {
		text = string(runes[:maxChatListPreview])
	}

	return text
}

// GetChatData returns chat data with messages in JSON format for dynamic loading
func (h *chatHandler) GetChatData(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	chatID, err := parseUintParam(c, "id")
	if err != nil {
		sendBadRequest(c, "Invalid chat ID")
		return
	}

	chat, err := h.chatService.FindChatByID(c.Request.Context(), chatID)
	if err != nil {
		sendForbidden(c, "Access denied")
		return
	}

	// Access check: group or 1-on-1
	if err := h.checkChatAccess(c, chat, userID); err != nil {
		return
	}

	messages, err := h.chatService.GetRecentMessages(c.Request.Context(), chatID, userID, maxRecentMessages)
	if err != nil {
		sendInternalError(c, "Failed to load messages")
		return
	}

	if chat.IsGroup {
		sendSuccess(c, gin.H{
			"chatID":       chatID,
			"is_group":     true,
			"group_name":   chat.GetGroupName(),
			"member_count": h.getGroupMemberCount(c.Request.Context(), chatID),
			"messages":     h.toMessageResponses(c.Request.Context(), messages, userID),
		})
		return
	}

	otherUser, otherUserID := chat.GetOtherUser(userID)
	sendSuccess(c, gin.H{
		"chatID":        chatID,
		"otherUserID":   otherUserID,
		"otherUsername": otherUser.GetDisplayName(),
		"messages":      h.toMessageResponses(c.Request.Context(), messages, userID),
	})
}

// ListChatsAPI returns list of chats for external UI (1-on-1 + groups)
func (h *chatHandler) ListChatsAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	chats, err := h.chatService.GetUserChats(c.Request.Context(), userID, true)
	if err != nil {
		sendInternalError(c, "Failed to load chats")
		return
	}

	unreadCounts, err := h.chatService.GetUnreadCounts(c.Request.Context(), userID)
	if err != nil {
		unreadCounts = make(map[uint]int64)
	}

	items := make([]chatListItem, 0, len(chats))
	for _, chat := range chats {
		lastMsg, lErr := h.chatService.GetLastMessageForChat(c.Request.Context(), chat.ID, userID)
		lastMessageText := formatLastMessage(lastMsg, lErr)

		// For scheme=2 messages the lastMessageText is the "🔒 placeholder"
		// (server can't decrypt). Pass the raw ciphertext + iv + sender so the
		// client can decrypt the preview locally and replace the placeholder.
		var (
			lmScheme   uint8
			lmCT       string
			lmIV       string
			lmSenderID uint
		)
		if lErr == nil && lastMsg != nil && lastMsg.Scheme == models.SchemeClientSide {
			lmScheme = lastMsg.Scheme
			lmCT = lastMsg.Text
			lmIV = lastMsg.IV
			lmSenderID = lastMsg.UserID
		}

		if chat.IsGroup {
			items = append(items, h.buildGroupListItem(c.Request.Context(), &chat, lastMessageText, unreadCounts, lmScheme, lmCT, lmIV, lmSenderID))
		} else {
			otherUser, otherUserID := chat.GetOtherUser(userID)
			h.userService.RefreshUserAvatarURL(otherUser)

			isFav := services.IsFavoritesChat(&chat)
			// For the self-chat we keep OtherUserID/AvatarURL pointing at the
			// current user (the math is the same) but blank the name — the client
			// renders "Избранное" + a special icon based on the IsFavorites flag.
			displayName := otherUser.GetDisplayName()
			if isFav {
				displayName = ""
			}

			items = append(items, chatListItem{
				ID:                    chat.ID,
				IsGroup:               false,
				OtherUserID:           otherUserID,
				OtherUserName:         displayName,
				IsFavorites:           isFav,
				AvatarURL:             otherUser.AvatarURL,
				LastMessage:           lastMessageText,
				LastMessageScheme:     lmScheme,
				LastMessageCiphertext: lmCT,
				LastMessageIV:         lmIV,
				LastMessageSenderID:   lmSenderID,
				UnreadCount:           int(unreadCounts[chat.ID]),
				UpdatedAt:             chat.UpdatedAt,
			})
		}
	}

	// Pin favorites to the top regardless of last activity. Within each bucket
	// the source order (updated_at DESC) is preserved by sort.SliceStable.
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].IsFavorites && !items[j].IsFavorites
	})

	sendSuccess(c, gin.H{"chats": items})
}

// CreateChatAPI creates a new chat via JSON request
func (h *chatHandler) CreateChatAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	var req struct {
		OtherUsername string `json:"other_username"`
		OtherUserID   uint   `json:"other_user_id"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		sendBadRequest(c, "Invalid input")
		return
	}

	var targetUserID uint
	switch {
	case req.OtherUserID != 0:
		targetUserID = req.OtherUserID
	case req.OtherUsername != "":
		otherUser, err := h.userService.FindByUsername(c.Request.Context(), req.OtherUsername)
		if err != nil {
			sendBadRequest(c, "User not found")
			return
		}
		targetUserID = otherUser.ID
	default:
		sendBadRequest(c, "other_user_id or other_username is required")
		return
	}

	if targetUserID == userID {
		sendBadRequest(c, "Cannot create chat with yourself")
		return
	}

	if req.OtherUserID != 0 {
		if _, err := h.userService.GetUserByID(c.Request.Context(), targetUserID); err != nil {
			sendBadRequest(c, "User not found")
			return
		}
	}

	chat, err := h.chatService.CreateChat(c.Request.Context(), userID, targetUserID)
	if err != nil {
		sendBadRequest(c, err.Error())
		return
	}

	sendCreated(c, gin.H{
		"id":         chat.ID,
		"user1_id":   chat.GetUser1ID(),
		"user2_id":   chat.GetUser2ID(),
		"created_at": chat.CreatedAt,
	})
}

// chatAction executes a chat operation (clear/delete) with shared validation logic.
// Broadcasts the event to the other participant BEFORE the destructive DB action,
// because DeleteChat hard-deletes the chat record (FindChatByIDLight would fail after).
func (h *chatHandler) chatAction(c *gin.Context, action func(ctx context.Context, chatID, userID uint) error, failMsg, successMsg, eventAction string) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	chatID, err := parseUintParam(c, "id")
	if err != nil {
		sendBadRequest(c, "Invalid chat ID")
		return
	}

	// Pre-validate access
	chat, err := h.chatService.FindChatByIDLight(c.Request.Context(), chatID)
	if err != nil {
		sendForbidden(c, "Access denied")
		return
	}

	if err := h.checkChatAccess(c, chat, userID); err != nil {
		return
	}

	// Capture participants BEFORE the destructive op so the dismiss-push
	// fanout below can address them — DeleteChat removes the chat row, so
	// a post-op lookup would 404 and the notifications would stay on
	// users' devices forever.
	participantIDs := h.resolveChatParticipants(c.Request.Context(), chat)

	// Broadcast BEFORE destructive action (chat record must exist for participant lookup)
	if h.onChatEvent != nil {
		h.onChatEvent(chatID, userID, eventAction)
	}

	if err := action(c.Request.Context(), chatID, userID); err != nil {
		errMsg := err.Error()
		if errMsg == errMsgAccessDenied || errMsg == "admin or creator role required" {
			sendForbidden(c, errMsg)
		} else {
			sendInternalError(c, failMsg)
		}
		return
	}

	// Dismiss any push notifications for this chat on every participant's
	// devices. The destructive op (clear / delete) wiped every recipient's
	// unread_messages row for the chat, so the dismiss is unconditional.
	if h.onUnreadDrained != nil && len(participantIDs) > 0 {
		h.onUnreadDrained(c.Request.Context(), chatID, participantIDs)
	}

	sendSuccess(c, gin.H{"message": successMsg})
}

// resolveChatParticipants returns the list of user IDs that participate in the
// chat: both 1-on-1 endpoints, or every chat_participant for a group. Caller
// uses it to fan out dismiss-pushes after a destructive chat-level op (clear /
// delete) — captured BEFORE the op so DeleteChat's row removal doesn't strand
// the lookup.
func (h *chatHandler) resolveChatParticipants(ctx context.Context, chat *models.Chat) []uint {
	if chat == nil {
		return nil
	}
	if !chat.IsGroup {
		ids := make([]uint, 0, 2)
		if u := chat.GetUser1ID(); u != 0 {
			ids = append(ids, u)
		}
		if u := chat.GetUser2ID(); u != 0 {
			ids = append(ids, u)
		}
		return ids
	}
	if h.groupService == nil {
		return nil
	}
	ids, err := h.groupService.GetParticipantUserIDs(ctx, chat.ID)
	if err != nil {
		return nil
	}
	return ids
}

// ClearChatAPI clears all messages in a chat
func (h *chatHandler) ClearChatAPI(c *gin.Context) {
	h.chatAction(c, h.chatService.ClearChat, "Failed to clear chat", "Chat cleared", "chat_cleared")
}

// DeleteChatAPI deletes a chat
func (h *chatHandler) DeleteChatAPI(c *gin.Context) {
	h.chatAction(c, h.chatService.DeleteChat, "Failed to delete chat", "Chat deleted", "chat_deleted")
}

// GetChatMessagesAPI returns chat messages for external UI
func (h *chatHandler) GetChatMessagesAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	chatID, err := parseUintParam(c, "id")
	if err != nil {
		sendBadRequest(c, "Invalid chat ID")
		return
	}

	chat, err := h.chatService.FindChatByIDLight(c.Request.Context(), chatID)
	if err != nil {
		sendForbidden(c, "Access denied")
		return
	}

	// Access check
	if err := h.checkChatAccess(c, chat, userID); err != nil {
		return
	}

	messages, err := h.chatService.GetMessages(c.Request.Context(), chatID, userID)
	if err != nil {
		sendInternalError(c, "Failed to load messages")
		return
	}

	resp := gin.H{
		"messages": h.toMessageResponses(c.Request.Context(), messages, userID),
	}
	// 1-on-1 read receipts: surface the peer's delivered/read pointers so the
	// sender's checkmarks render correctly on chat open, not only after a live
	// message_status event. Groups get nothing for v1.
	if !chat.IsGroup {
		otherUserID := chat.GetUser1ID()
		if otherUserID == userID {
			otherUserID = chat.GetUser2ID()
		}
		if receipt, rErr := h.chatService.GetPeerReceipt(c.Request.Context(), chatID, otherUserID); rErr == nil && receipt != nil {
			resp["last_delivered"] = receipt.LastDeliveredMessageID
			resp["last_read"] = receipt.LastReadMessageID
		}
	}
	sendSuccess(c, resp)
}
