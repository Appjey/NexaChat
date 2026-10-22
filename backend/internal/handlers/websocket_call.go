package handlers

import (
	"context"
	"encoding/json"
	"messenger/internal/i18n"

	"messenger/internal/models"

	"go.uber.org/zap"
)

// handleCallSignaling relays WebRTC signaling messages between two users in a 1-on-1 chat.
// The server is stateless — it only validates access and forwards the payload.
func (h *webSocketHandler) handleCallSignaling(ctx context.Context, userID uint, rawMsg []byte) error {
	var ca callAction
	if err := json.Unmarshal(rawMsg, &ca); err != nil {
		return &wsError{message: "Invalid call signaling format"}
	}

	if ca.ChatID == 0 {
		return &wsError{message: "chat_id is required for call signaling"}
	}
	if ca.CallID == "" {
		return &wsError{message: "call_id is required for call signaling"}
	}

	chat, err := h.chatService.FindChatByIDLight(ctx, ca.ChatID)
	if err != nil {
		return &wsError{message: "Chat not found"}
	}
	if chat.IsGroup {
		return &wsError{message: "Calls are only supported in 1-on-1 chats"}
	}
	if !chat.HasUser(userID) {
		return &wsError{message: errMsgChatAccessDenied}
	}

	otherUserID := chat.GetUser1ID()
	if otherUserID == userID {
		otherUserID = chat.GetUser2ID()
	}

	if ca.Action == actionCallOffer && !h.presenceService.IsUserOnline(otherUserID) {
		// Callee offline: register the call, fire a doorbell push, and keep the
		// caller ringing (return nil, not an error). The SDP is intentionally
		// NOT relayed — when the callee taps the push, opens the app and emits
		// call_ready, the caller mints a fresh offer (see handleCallSignaling's
		// call_ready relay + the frontend re-offer flow). This avoids shipping a
		// stale SDP through the ring window.
		h.registerCall(userID, otherUserID, ca.CallID, ca.ChatID)
		go h.sendCallPush(context.Background(), userID, otherUserID, ca.CallID, ca.ChatID) //nolint:contextcheck // detached on purpose
		h.logger.Debug("callee offline — sent call doorbell push",
			zap.Uint("caller", userID),
			zap.Uint("callee", otherUserID),
			zap.String("call_id", ca.CallID),
		)
		return nil
	}

	// Track active calls for disconnect notification
	switch ca.Action {
	case actionCallOffer:
		h.registerCall(userID, otherUserID, ca.CallID, ca.ChatID)
	case actionCallHangup, actionCallReject:
		h.unregisterCall(userID)
	}

	relayData := map[string]any{
		"action":  ca.Action,
		"chat_id": ca.ChatID,
		"call_id": ca.CallID,
		"user_id": userID,
	}
	if ca.SDP != "" {
		relayData["sdp"] = ca.SDP
		relayData["sdp_type"] = ca.SDPType
	}
	if ca.Candidate != "" {
		relayData["candidate"] = ca.Candidate
	}

	msgJSON, err := json.Marshal(relayData)
	if err != nil {
		return &wsError{message: "Failed to marshal call signal"}
	}

	h.broadcastToUser(otherUserID, msgJSON)

	h.logger.Debug("relayed call signal",
		zap.String("action", ca.Action),
		zap.Uint("from", userID),
		zap.Uint("to", otherUserID),
		zap.String("call_id", ca.CallID),
	)

	return nil
}

// sendCallPush delivers the "incoming call" doorbell to an offline callee, over
// both FCM (mobile) and Web Push (web fallback). Best-effort and detached — the
// caller's ring window is the real timeout. The push carries no SDP; it only
// wakes the callee so the re-offer handshake can run.
func (h *webSocketHandler) sendCallPush(ctx context.Context, callerID, calleeID uint, callID string, chatID uint) {
	defer func() {
		if r := recover(); r != nil {
			h.logger.Error("panic in call-push goroutine", zap.Any("panic", r))
		}
	}()
	if h.pushService == nil || !h.pushService.IsEnabled() {
		return
	}
	callerName := i18n.IncomingCallFallbackName
	if h.userService != nil {
		if u, err := h.userService.GetUserByID(ctx, callerID); err == nil && u != nil {
			if name := u.GetDisplayName(); name != "" {
				callerName = name
			}
		}
	}
	if err := h.pushService.SendCallPush(ctx, calleeID, callerName, callID, chatID, callerID); err != nil {
		h.logger.Warn("call push failed", zap.Error(err), zap.Uint("callee", calleeID))
	}
}

// handleCallMissed posts the "Пропущенный звонок" system message when the
// caller's ring window expires. Guarded by activeCalls: only the registered
// caller for this exact call_id may post it, so a client can't spam system
// messages into arbitrary chats.
func (h *webSocketHandler) handleCallMissed(ctx context.Context, userID uint, rawMsg []byte) error {
	var ca callAction
	if err := json.Unmarshal(rawMsg, &ca); err != nil {
		return &wsError{message: "Invalid call format"}
	}
	if ca.ChatID == 0 || ca.CallID == "" {
		return &wsError{message: "chat_id and call_id are required"}
	}

	// call_id guard: the sender must be the registered caller for this call.
	h.callsMu.Lock()
	info, ok := h.activeCalls[userID]
	h.callsMu.Unlock()
	if !ok || info.callID != ca.CallID || info.chatID != ca.ChatID {
		return &wsError{message: "no matching active call"}
	}
	calleeID := info.peerUserID
	h.unregisterCall(userID)

	recipientOffline := !h.presenceService.IsUserOnline(calleeID)
	msg, err := h.chatService.PostCallSystemMessage(ctx, ca.ChatID, calleeID, callMissedText, recipientOffline)
	if err != nil {
		h.logger.Warn("failed to post missed-call message", zap.Error(err), zap.Uint("chat_id", ca.ChatID))
		return nil // best-effort
	}

	broadcastData := map[string]any{
		"action":     "new",
		"chat_id":    ca.ChatID,
		"user_id":    uint(0),
		"text":       msg.Text,
		"type":       string(models.MessageTypeSystem),
		"id":         msg.ID,
		"created_at": msg.CreatedAt,
		"is_deleted": false,
	}
	msgJSON, err := json.Marshal(broadcastData)
	if err != nil {
		return &wsError{message: "Server error"}
	}
	if err := h.broadcastToChat(ctx, ca.ChatID, msgJSON); err != nil {
		h.logger.Warn("failed to broadcast missed-call message", zap.Error(err), zap.Uint("chat_id", ca.ChatID))
	}
	return nil
}

// registerCall tracks an active call between two users for disconnect notification.
func (h *webSocketHandler) registerCall(userID, peerUserID uint, callID string, chatID uint) {
	h.callsMu.Lock()
	defer h.callsMu.Unlock()
	h.activeCalls[userID] = activeCallInfo{peerUserID: peerUserID, callID: callID, chatID: chatID}
	h.activeCalls[peerUserID] = activeCallInfo{peerUserID: userID, callID: callID, chatID: chatID}
}

// unregisterCall removes call tracking for a user and their peer.
func (h *webSocketHandler) unregisterCall(userID uint) {
	h.callsMu.Lock()
	defer h.callsMu.Unlock()
	if info, ok := h.activeCalls[userID]; ok {
		delete(h.activeCalls, info.peerUserID)
		delete(h.activeCalls, userID)
	}
}

// notifyCallPeerOnDisconnect sends call_hangup to the peer if the user had an active call
// and has no remaining connections (avoids TOCTOU race by checking under lock).
func (h *webSocketHandler) notifyCallPeerOnDisconnect(userID uint) {
	h.mu.RLock()
	hasConnections := len(h.clients[userID]) > 0
	h.mu.RUnlock()
	if hasConnections {
		return
	}

	h.callsMu.Lock()
	info, ok := h.activeCalls[userID]
	if ok {
		delete(h.activeCalls, userID)
		delete(h.activeCalls, info.peerUserID)
	}
	h.callsMu.Unlock()

	if !ok {
		return
	}

	hangupData := map[string]any{
		"action":  actionCallHangup,
		"chat_id": info.chatID,
		"call_id": info.callID,
		"user_id": userID,
	}
	msgJSON, err := json.Marshal(hangupData)
	if err != nil {
		h.logger.Error("failed to marshal disconnect hangup", zap.Error(err), zap.Uint("user_id", userID))
		return
	}

	h.broadcastToUser(info.peerUserID, msgJSON)
	h.logger.Debug("sent call_hangup on disconnect",
		zap.Uint("disconnected_user", userID),
		zap.Uint("notified_peer", info.peerUserID),
		zap.String("call_id", info.callID),
	)
}
