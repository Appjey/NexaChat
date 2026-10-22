package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

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

// wsError represents a WebSocket error
type wsError struct {
	message string
}

// Verify interface compliance at compile time.
var _ error = (*wsError)(nil) //nolint:errcheck // compile-time interface check

func (e *wsError) Error() string {
	return e.message
}
