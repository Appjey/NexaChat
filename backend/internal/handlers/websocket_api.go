package handlers

import (
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// GetUnreadMessagesAPI returns all unread messages for the current user
func (h *webSocketHandler) GetUnreadMessagesAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	unreadMessages, err := h.chatService.GetUnreadMessagesForUser(c.Request.Context(), userID)
	if err != nil {
		h.logger.Error("failed to get unread messages",
			zap.Error(err),
			zap.Uint("user_id", userID),
		)
		sendInternalError(c, "Failed to load unread messages")
		return
	}

	sendSuccess(c, gin.H{
		"unread_messages": unreadMessages,
	})
}

// GetUnreadCountsAPI returns unread message counts per chat
func (h *webSocketHandler) GetUnreadCountsAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	counts, err := h.chatService.GetUnreadCounts(c.Request.Context(), userID)
	if err != nil {
		h.logger.Error("failed to get unread counts",
			zap.Error(err),
			zap.Uint("user_id", userID),
		)
		sendInternalError(c, "Failed to load unread counts")
		return
	}

	sendSuccess(c, gin.H{
		"unread_counts": counts,
	})
}

// GetUserPresenceAPI returns online status of a user
func (h *webSocketHandler) GetUserPresenceAPI(c *gin.Context) {
	_, ok := requireUserID(c)
	if !ok {
		return
	}

	targetUserID, err := parseUintParam(c, "user_id")
	if err != nil {
		sendBadRequest(c, "Invalid user ID")
		return
	}

	status := h.presenceService.GetUserStatus(targetUserID)

	// If the user was evicted from the in-memory presence map (offline > 1h),
	// status.LastSeen is the zero time — fall back to the persisted column.
	lastSeen := status.LastSeen
	if lastSeen.IsZero() && h.userService != nil {
		if user, err := h.userService.GetUserByID(c.Request.Context(), targetUserID); err == nil && user.LastSeenAt != nil {
			lastSeen = *user.LastSeenAt
		}
	}

	sendSuccess(c, gin.H{
		"user_id":   status.UserID,
		"is_online": status.IsOnline,
		"last_seen": lastSeen,
	})
}
