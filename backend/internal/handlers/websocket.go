package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"messenger/internal/models"
	"messenger/internal/repositories"
	"messenger/internal/services"
	"messenger/internal/storage"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

type wsClient struct {
	ctx          context.Context
	cancel       context.CancelFunc
	lastMessage  time.Time
	conn         *websocket.Conn
	userID       uint
	messageCount int
	mu           sync.Mutex
	writeMu      sync.Mutex // Protects all writes to conn (Gorilla WebSocket not thread-safe)
}

// activeCallInfo tracks an in-progress call for disconnect notification.
type activeCallInfo struct {
	peerUserID uint
	callID     string
	chatID     uint
}

// webSocketHandler manages global WebSocket connections
type webSocketHandler struct {
	chatService       *services.ChatService
	presenceService   *services.PresenceService
	pushService       *services.PushNotificationService
	userService       *services.UserService
	groupService      *services.GroupService
	attachmentService *services.AttachmentService
	participantRepo   *repositories.ChatParticipantRepo
	unreadMessageRepo *repositories.UnreadMessageRepo
	logger            *zap.Logger
	fileStorage       storage.Storage
	clients           map[uint][]*wsClient // userID -> []clients
	mu                sync.RWMutex
	activeCalls       map[uint]activeCallInfo // userID -> active call peer
	callsMu           sync.Mutex
	broadcastPool     *workerPool // Limits concurrent broadcast goroutines
	// allowedOrigins is the browser-origin allow-list for the upgrade handshake,
	// the same list the CORS middleware uses. Nil/empty means "reject every
	// browser origin".
	allowedOrigins map[string]struct{}
}

// newWebSocketHandler creates a new global WebSocket handler.
func newWebSocketHandler(
	chatService *services.ChatService,
	presenceService *services.PresenceService,
	pushService *services.PushNotificationService,
	userService *services.UserService,
	logger *zap.Logger,
	fileStorage storage.Storage,
	allowedOrigins []string,
) *webSocketHandler {
	h := &webSocketHandler{
		chatService:     chatService,
		presenceService: presenceService,
		pushService:     pushService,
		userService:     userService,
		logger:          logger,
		fileStorage:     fileStorage,
		clients:         make(map[uint][]*wsClient),
		activeCalls:     make(map[uint]activeCallInfo),
		broadcastPool:   newWorkerPool(50), // 50 workers for broadcast concurrency
	}
	h.SetAllowedOrigins(allowedOrigins)
	return h
}

// SetAllowedOrigins installs the Origin allow-list consulted by checkOrigin
// during the WebSocket upgrade. Matching is case-insensitive on the whole
// origin string (scheme + host + port), mirroring gin-contrib/cors.
func (h *webSocketHandler) SetAllowedOrigins(origins []string) {
	set := make(map[string]struct{}, len(origins))
	for _, o := range origins {
		if o = strings.TrimSpace(o); o != "" {
			set[strings.ToLower(o)] = struct{}{}
		}
	}
	h.allowedOrigins = set
}

// SetGroupService sets the group service and participant repo for group chat support.
func (h *webSocketHandler) SetGroupService(gs *services.GroupService, pr *repositories.ChatParticipantRepo) {
	h.groupService = gs
	h.participantRepo = pr
}

// SetAttachmentService injects the attachment service so the unread-replay
// path can pre-resolve the recipient's per-user envelope (encrypted_file_key
// + envelope_iv) for any scheme=2 attachments queued offline.
func (h *webSocketHandler) SetAttachmentService(as *services.AttachmentService) {
	h.attachmentService = as
}

// SetUnreadMessageRepo injects the unread-messages repo so the auto-dismiss
// path (handleDeleteMessage / handleClearChat etc.) can check per-recipient
// "is unread still > 0 in this chat?" before firing a SendDismiss push.
func (h *webSocketHandler) SetUnreadMessageRepo(repo *repositories.UnreadMessageRepo) {
	h.unreadMessageRepo = repo
}

// Close drains all active WebSocket connections and stops the broadcast worker pool.
// Sends a "going away" close frame to every client so they reconnect cleanly on restart.
// Intended to be registered with the graceful-shutdown manager before srv.Shutdown.
func (h *webSocketHandler) Close(ctx context.Context) error {
	h.mu.Lock()
	clients := make([]*wsClient, 0)
	for _, conns := range h.clients {
		clients = append(clients, conns...)
	}
	// Don't wipe the map yet — the read/write loops cleanup themselves and this lets
	// any in-flight broadcast still find its target until conn.Close flushes.
	h.mu.Unlock()

	h.logger.Info("draining WebSocket clients", zap.Int("count", len(clients)))

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(5 * time.Second)
	}

	closeFrame := websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutting down")
	for _, c := range clients {
		c.writeMu.Lock()
		// Best-effort — the connection is already on its way out, so errors here are expected
		// (peer closed the socket, deadline exceeded). Log at debug so we have a trail without
		// spamming warnings on every shutdown.
		if err := c.conn.WriteControl(websocket.CloseMessage, closeFrame, deadline); err != nil {
			h.logger.Debug("close frame write failed", zap.Error(err), zap.Uint("user_id", c.userID))
		}
		c.writeMu.Unlock()
		if err := c.conn.Close(); err != nil {
			h.logger.Debug("conn close failed", zap.Error(err), zap.Uint("user_id", c.userID))
		}
	}

	// Stop the broadcast pool so worker goroutines exit their range loop.
	h.broadcastPool.Close()

	return nil
}

// HandleWebSocket handles the global WebSocket connection for a user
func (h *webSocketHandler) HandleWebSocket(c *gin.Context) {
	// Deliberately no query string here: it carries the JWT (?token=...).
	h.logger.Info("WebSocket handler called",
		zap.String("path", c.Request.URL.Path),
	)

	userID, ok := requireUserID(c)
	if !ok {
		h.logger.Warn("WebSocket: no user_id in context")
		return
	}
	h.logger.Info("WebSocket: user authenticated", zap.Uint("user_id", userID))

	// Check connection limit
	if !h.checkConnectionLimit(c, userID) {
		return
	}

	// Upgrade to WebSocket
	conn, err := h.upgradeConnection(c)
	if err != nil {
		return
	}

	// Create context that will be canceled when connection closes
	ctx, cancel := context.WithCancel(context.Background())

	// Setup connection and client
	client := h.setupConnection(ctx, cancel, conn, userID)

	// Start background tasks
	done := h.startBackgroundTasks(client, userID)

	// Cleanup on exit
	defer h.cleanup(done, client, userID, conn)

	// Handle incoming messages
	h.handleReadLoop(client, userID, conn)
}

// checkConnectionLimit verifies the user hasn't exceeded connection limits
func (h *webSocketHandler) checkConnectionLimit(c *gin.Context, userID uint) bool {
	h.mu.RLock()
	userConns := len(h.clients[userID])
	h.mu.RUnlock()

	if userConns >= maxConnectionsPerUser {
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many connections"})
		return false
	}
	return true
}

// upgradeConnection upgrades HTTP connection to WebSocket
func (h *webSocketHandler) upgradeConnection(c *gin.Context) (*websocket.Conn, error) {
	upgrader := websocket.Upgrader{
		CheckOrigin:     h.checkOrigin,
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
	}

	h.logger.Info("attempting WebSocket upgrade",
		zap.String("origin", c.GetHeader("Origin")),
		zap.String("host", c.Request.Host),
	)

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		h.logger.Error("websocket upgrade error",
			zap.Error(err),
			zap.String("origin", c.GetHeader("Origin")),
		)
		return nil, err
	}

	h.logger.Info("WebSocket upgrade successful")
	return conn, nil
}

// setupConnection configures the WebSocket connection and creates client
func (h *webSocketHandler) setupConnection(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn, userID uint) *wsClient {
	// Configure connection limits
	conn.SetReadLimit(maxMessageSize)
	if err := conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		h.logger.Warn("failed to set initial read deadline", zap.Error(err))
	}
	conn.SetPongHandler(func(string) error {
		if err := conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
			h.logger.Warn("failed to set read deadline in pong handler", zap.Error(err))
		}
		h.presenceService.UpdateActivity(userID)
		return nil
	})

	client := &wsClient{
		ctx:         ctx,
		cancel:      cancel,
		conn:        conn,
		userID:      userID,
		lastMessage: time.Now(),
	}

	// Add client to map
	h.mu.Lock()
	h.clients[userID] = append(h.clients[userID], client)
	h.mu.Unlock()

	// Mark user as online
	h.presenceService.UserConnected(userID)

	return client
}

// startBackgroundTasks starts write pump and pending message delivery
func (h *webSocketHandler) startBackgroundTasks(client *wsClient, userID uint) chan struct{} {
	// Send pending unread messages
	go h.sendPendingMessages(client, userID)

	// Start ping ticker
	ticker := time.NewTicker(pingPeriod)
	done := make(chan struct{})

	// Start write pump (ping sender)
	go func() {
		defer ticker.Stop()
		defer func() {
			if r := recover(); r != nil {
				h.logger.Error("panic in write pump",
					zap.Any("panic", r),
					zap.Uint("user_id", userID),
				)
			}
		}()
		h.writePump(client, ticker, done)
	}()

	return done
}

// writePump sends periodic ping messages to keep connection alive
func (h *webSocketHandler) writePump(client *wsClient, ticker *time.Ticker, done chan struct{}) {
	for {
		select {
		case <-ticker.C:
			// Protect writes with mutex (Gorilla WebSocket not thread-safe)
			client.writeMu.Lock()
			if err := client.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
				h.logger.Warn("failed to set write deadline for ping", zap.Error(err))
				client.writeMu.Unlock()
				return
			}
			if err := client.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				client.writeMu.Unlock()
				return
			}
			client.writeMu.Unlock()
		case <-done:
			return
		}
	}
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

// cleanup performs cleanup when connection closes
func (h *webSocketHandler) cleanup(done chan struct{}, client *wsClient, userID uint, conn *websocket.Conn) {
	close(done)
	client.cancel() // Cancel context to stop any pending operations
	h.removeClient(userID, client)
	h.notifyCallPeerOnDisconnect(userID)
	h.presenceService.UserDisconnected(userID)
	if closeErr := conn.Close(); closeErr != nil {
		h.logger.Warn("failed to close websocket connection", zap.Error(closeErr), zap.Uint("user_id", userID))
	}
}

// sendError sends error message to WebSocket client
func (h *webSocketHandler) sendError(client *wsClient, errorMsg string) {
	errData := map[string]any{
		"error": errorMsg,
	}
	errJSON, err := json.Marshal(errData)
	if err != nil {
		h.logger.Error("failed to marshal error message", zap.Error(err))
		return
	}

	// Protect writes with mutex (Gorilla WebSocket not thread-safe)
	client.writeMu.Lock()
	defer client.writeMu.Unlock()

	if err := client.conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
		h.logger.Warn("failed to set write deadline for error message", zap.Error(err))
	}
	if err := client.conn.WriteMessage(websocket.TextMessage, errJSON); err != nil {
		h.logger.Error("failed to send error message", zap.Error(err))
	}
}

// handleReadLoop processes incoming WebSocket messages
func (h *webSocketHandler) handleReadLoop(client *wsClient, userID uint, conn *websocket.Conn) {
	defer func() {
		if r := recover(); r != nil {
			h.logger.Error("panic in websocket handler",
				zap.Any("panic", r),
				zap.Uint("user_id", userID),
			)
		}
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				h.logger.Error("websocket error",
					zap.Error(err),
					zap.Uint("user_id", userID),
				)
			}
			break
		}

		// Update activity
		h.presenceService.UpdateActivity(userID)

		// Rate limiting check
		if !h.checkRateLimit(client) {
			h.logger.Warn("rate limit exceeded", zap.Uint("user_id", userID))
			h.sendError(client, "Rate limit exceeded. Please slow down.")
			continue
		}

		// Parse and handle message
		if err := h.processMessage(client.ctx, userID, msg); err != nil {
			h.sendError(client, err.Error())
		}
	}
}

// processMessage parses and routes a WebSocket message to appropriate handler
func (h *webSocketHandler) processMessage(ctx context.Context, userID uint, msg []byte) error {
	var msgData messageAction
	if err := json.Unmarshal(msg, &msgData); err != nil {
		h.logger.Error("invalid message format", zap.Error(err), zap.Uint("user_id", userID))
		return &wsError{message: "Invalid message format"}
	}

	// Validate chat_id is provided
	if msgData.ChatID == 0 && msgData.Action != "mark_read" {
		return &wsError{message: "chat_id is required"}
	}

	// Default action is "send" for backward compatibility
	if msgData.Action == "" {
		msgData.Action = "send"
	}

	// Route to appropriate handler
	switch msgData.Action {
	case "send":
		return h.handleSendMessage(ctx, userID, msgData)
	case "edit":
		return h.handleEditMessage(ctx, userID, msgData)
	case "delete":
		return h.handleDeleteMessage(ctx, userID, msgData)
	case "mark_read":
		return h.handleMarkRead(ctx, userID, msgData)
	case "delivered":
		return h.handleMarkDelivered(ctx, userID, msgData)
	case "chat_opened":
		return h.handleChatOpened(ctx, userID, msgData)
	case actionCallOffer, actionCallAnswer, actionCallICE, actionCallHangup, actionCallReject, actionCallReady:
		return h.handleCallSignaling(ctx, userID, msg)
	case actionCallMissed:
		return h.handleCallMissed(ctx, userID, msg)
	default:
		return &wsError{message: "Unknown action: " + msgData.Action}
	}
}

// checkOrigin validates the WebSocket upgrade against the same origin
// allow-list the CORS middleware uses (ALLOWED_ORIGINS).
//
// A missing Origin header is accepted: browsers always send it on WebSocket
// handshakes, so its absence means a non-browser client (curl, a native app
// without a WebView), which can't be the victim of cross-site WebSocket
// hijacking in the first place — the JWT check still applies to it.
func (h *webSocketHandler) checkOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	if _, ok := h.allowedOrigins[strings.ToLower(origin)]; ok {
		return true
	}
	h.logger.Warn("WebSocket origin rejected",
		zap.String("origin", origin),
		zap.String("host", r.Host),
	)
	return false
}

// checkRateLimit enforces rate limiting per connection
func (h *webSocketHandler) checkRateLimit(client *wsClient) bool {
	client.mu.Lock()
	defer client.mu.Unlock()

	now := time.Now()
	if now.Sub(client.lastMessage) > time.Second {
		client.messageCount = 0
		client.lastMessage = now
	}

	if client.messageCount >= maxMessagesPerSecond {
		return false
	}

	client.messageCount++
	return true
}

// removeClient safely removes a client from the map
func (h *webSocketHandler) removeClient(userID uint, client *wsClient) {
	h.mu.Lock()
	defer h.mu.Unlock()

	clients := h.clients[userID]
	for i, c := range clients {
		if c == client {
			h.clients[userID] = append(clients[:i], clients[i+1:]...)
			break
		}
	}

	if len(h.clients[userID]) == 0 {
		delete(h.clients, userID)
	}
}

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

// wsError represents a WebSocket error
type wsError struct {
	message string
}

// Verify interface compliance at compile time.
var _ error = (*wsError)(nil) //nolint:errcheck // compile-time interface check

func (e *wsError) Error() string {
	return e.message
}

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

// workerPool manages a pool of workers to limit concurrent goroutines
type workerPool struct {
	workers  int
	jobQueue chan func()
}

// newWorkerPool creates a new worker pool with the specified number of workers
func newWorkerPool(workers int) *workerPool {
	pool := &workerPool{
		workers:  workers,
		jobQueue: make(chan func(), 1000), // Buffer for 1000 pending jobs
	}

	// Start worker goroutines
	for i := 0; i < workers; i++ {
		go pool.worker()
	}

	return pool
}

// worker processes jobs from the queue
func (p *workerPool) worker() {
	for job := range p.jobQueue {
		job()
	}
}

// Submit adds a job to the worker pool
func (p *workerPool) Submit(job func()) {
	p.jobQueue <- job
}

// Close shuts down the worker pool (optional, for cleanup)
func (p *workerPool) Close() {
	close(p.jobQueue)
}
