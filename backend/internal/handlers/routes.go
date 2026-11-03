package handlers

import (
	"context"
	"time"

	"messenger/internal/config"
	"messenger/internal/repositories"
	"messenger/internal/services"
	"messenger/internal/storage"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// SetupRoutes registers all HTTP and WebSocket routes on the given router.
// Returns a cleanup function that drains active WebSocket connections and stops the
// broadcast worker pool — register it with the graceful-shutdown manager before
// the HTTP server's own Shutdown is called so clients get a clean CloseGoingAway.
func SetupRoutes(
	router *gin.Engine,
	db *gorm.DB,
	secret []byte,
	fileStorage storage.Storage,
	logger *zap.Logger,
	cfg *config.Config,
) (func(context.Context) error, error) {
	// Initialize repositories
	userRepo := repositories.NewUserRepo(db)
	chatRepo := repositories.NewChatRepo(db)
	messageRepo := repositories.NewMessageRepo(db)
	envelopeRepo := repositories.NewMessageEnvelopeRepo(db)
	contactRepo := repositories.NewContactRepo(db)
	attachmentRepo := repositories.NewAttachmentRepo(db)
	attachmentEnvelopeRepo := repositories.NewAttachmentEnvelopeRepo(db)
	unreadMessageRepo := repositories.NewUnreadMessageRepo(db)
	pushSubRepo := repositories.NewPushSubscriptionRepo(db)
	fcmTokenRepo := repositories.NewFCMTokenRepo(db)
	participantRepo := repositories.NewChatParticipantRepo(db)
	prefRepo := repositories.NewPreferenceRepo(db)

	// Initialize services
	authService := services.NewAuthService(logger, userRepo)
	sessionService := services.NewSessionService(logger, repositories.NewSessionRepo(db))
	chatService := services.NewChatService(db, logger, chatRepo, participantRepo, messageRepo, envelopeRepo, unreadMessageRepo, repositories.NewMessageReceiptRepo(db), fileStorage)
	contactService := services.NewContactService(logger, contactRepo)
	attachmentService := services.NewAttachmentService(db, logger, attachmentRepo, attachmentEnvelopeRepo, messageRepo, chatRepo, participantRepo, fileStorage)
	userService := services.NewUserService(logger, userRepo, fileStorage)
	presenceService := services.NewPresenceService(logger)
	pushService := services.NewPushNotificationService(logger, pushSubRepo, cfg.VAPIDPublicKey, cfg.VAPIDPrivateKey, cfg.VAPIDSubject)
	fcmService := services.NewFCMService(logger, fcmTokenRepo, cfg.FCMCredentialsPath)
	pushService.SetFCMService(fcmService)
	groupService := services.NewGroupService(db, logger, chatRepo, participantRepo, messageRepo, unreadMessageRepo, userRepo, fileStorage)
	pinService := services.NewPinService(db, logger, repositories.NewPinnedMessageRepo(db), messageRepo, envelopeRepo, chatRepo, participantRepo, userRepo)
	appReleaseService := services.NewAppReleaseService(logger, repositories.NewAppReleaseRepo(db))
	prefService := services.NewPreferenceService(logger, prefRepo, chatRepo, participantRepo)

	tokenTTL := time.Duration(cfg.JWTExpiryDays) * 24 * time.Hour
	requireAuth := jwtMiddleware(secret, logger, tokenTTL, sessionService, cfg.AllowedOrigins)

	backfillFavoritesChats(logger, userRepo, chatService)

	// Initialize handlers
	authH := newAuthHandler(authHandlerDeps{
		Auth: authService, Users: userService, Chats: chatService, Sessions: sessionService,
		Limiter: services.NewLoginLimiter(), Logger: logger, Secret: secret, TokenTTL: tokenTTL,
	})
	chatH := newChatHandler(chatService, userService, fileStorage)
	chatH.SetGroupService(groupService)
	chatH.SetAttachmentService(attachmentService)
	profileH := newProfileHandler(userService, contactService, logger)
	userH := newUserHandler(userService)
	wsH := newWebSocketHandler(chatService, presenceService, pushService, userService, logger, fileStorage, cfg.AllowedOrigins)
	wsH.SetGroupService(groupService, participantRepo)
	wsH.SetAttachmentService(attachmentService)
	wsH.SetUnreadMessageRepo(unreadMessageRepo)
	attachH := newAttachmentHandler(attachmentService, chatService, wsH, participantRepo, fileStorage)
	fileH := newFileHandler(fileStorage, logger)
	pushH := newPushHandler(pushService, fcmService, logger)
	healthH := newHealthHandler(db)
	groupH := newGroupHandler(groupService, presenceService, userService)
	pinH := newPinHandler(pinService, fileStorage)
	releaseH := newAppReleaseHandler(appReleaseService, cfg.AdminAPIKey, logger)
	clientErrorH := newClientErrorHandler(logger)
	prefH := newPreferenceHandler(prefService)

	// Configure presence service to broadcast status changes via WebSocket
	presenceService.SetOnChangeCallback(wsH.broadcastPresenceChange)

	// Configure chat handler to broadcast chat events (clear/delete) via WebSocket
	chatH.SetOnChatEventCallback(wsH.broadcastChatEvent)
	// And to fan out dismiss-pushes after destructive chat ops drain unread
	// for every participant — keeps notification trays in sync across devices.
	chatH.SetOnUnreadDrainedCallback(wsH.dismissForParticipants)

	// Configure group handler to broadcast group events via WebSocket
	groupH.setOnGroupEventCallback(wsH.broadcastGroupEvent)

	// Configure pin handler to broadcast pin events via WebSocket
	pinH.setOnPinEventCallback(wsH.broadcastPinEvent)

	// Configure preference handler to broadcast sync events via WebSocket
	prefH.setOnPreferenceEventCallback(wsH.broadcastPreferenceEvent)

	// Public endpoints (no JWT middleware)
	router.GET("/health", healthH.GetHealth)
	router.POST("/api/auth/register", authH.RegisterAPI)
	router.POST("/api/auth/login", authH.LoginAPI)

	// Attachment download — JWT required (presigned URLs are the primary access method)
	router.GET("/api/attachments/:id", requireAuth, attachH.DownloadAttachment)

	// Public avatar endpoints
	router.GET("/api/avatars/:user_id", userH.GetAvatar)
	router.GET("/api/group-avatars/:chat_id", groupH.GetGroupAvatar)

	// Self-update: latest-release lookup is public so unauthenticated clients
	// (e.g. an app stuck on a mandatory-update screen before login) can still
	// poll for the build they need to install.
	router.GET("/api/updates/latest", releaseH.GetLatestRelease)

	// Admin endpoint for registering new releases. Auth is via X-Admin-Key
	// header (NOT JWT) so the CI pipeline doesn't need to mint a real user
	// session. Disabled when ADMIN_API_KEY is unset (returns 503).
	router.POST("/api/admin/releases", releaseH.CreateRelease)

	// WebSocket endpoint with JWT middleware
	router.GET("/ws", requireAuth, wsH.HandleWebSocket)

	// Protected attachment endpoint (DELETE requires JWT)
	router.DELETE("/api/attachments/:id", requireAuth, attachH.DeleteAttachment)

	// Protected API routes (JWT required)
	api := router.Group("/api")
	api.Use(requireAuth)
	registerAuthRoutes(api, authH)
	registerChatRoutes(api, chatH, attachH, pinH, wsH)
	registerProfileRoutes(api, profileH)
	registerUserRoutes(api, userH, wsH, fileH)
	registerPushRoutes(api, pushH)
	registerGroupRoutes(api, groupH)
	registerClientErrorRoutes(api, clientErrorH)
	registerPreferenceRoutes(api, prefH)

	return wsH.Close, nil
}

// backfillFavoritesChats creates the "Saved Messages" self-chat for every
// existing user. Idempotent thanks to the (user1_id, user2_id) unique
// constraint: re-runs do nothing. Runs synchronously at startup; for our user
// base (<10k) it's instant.
func backfillFavoritesChats(logger *zap.Logger, userRepo *repositories.UserRepo, chatService *services.ChatService) {
	userIDs, err := userRepo.AllUserIDs(context.Background())
	if err != nil {
		logger.Warn("favorites backfill: failed to enumerate users", zap.Error(err))
		return
	}
	chatService.EnsureFavoritesChatsForAllUsers(context.Background(), userIDs)
}

func registerAuthRoutes(api *gin.RouterGroup, h *authHandler) {
	auth := api.Group("/auth")
	auth.POST("/logout", h.LogoutAPI)
	auth.PUT("/password", h.ChangePasswordAPI)
	auth.GET("/me", h.GetCurrentUser)
	auth.PUT("/vault", h.UpdateVaultAPI)
}

//nolint:dupl // Chat and group routes share structure but different handlers; merging hurts readability.
func registerChatRoutes(api *gin.RouterGroup, ch *chatHandler, ah *attachmentHandler, ph *pinHandler, wh *webSocketHandler) {
	chats := api.Group("/chats")
	chats.GET("", ch.ListChatsAPI)
	chats.POST("", ch.CreateChatAPI)
	chats.GET("/:id", ch.GetChatData)
	chats.DELETE("/:id", ch.DeleteChatAPI)
	chats.POST("/:id/clear", ch.ClearChatAPI)
	chats.POST("/:id/forward", wh.ForwardMessageAPI)
	chats.GET("/:id/messages", ch.GetChatMessagesAPI)
	chats.POST("/:id/messages/:message_id/attachments", ah.UploadAttachments)
	chats.POST("/:id/messages/:message_id/pin", ph.PinMessageAPI)
	chats.DELETE("/:id/messages/:message_id/pin", ph.UnpinMessageAPI)
	chats.GET("/:id/pins", ph.GetPinnedMessagesAPI)
}

func registerProfileRoutes(api *gin.RouterGroup, h *profileHandler) {
	profile := api.Group("/profile")
	profile.GET("", h.GetProfileAPI)
	profile.PUT("", h.UpdateProfileAPI)
	profile.GET("/:user_id", h.GetProfileAPI)

	contacts := api.Group("/contacts")
	contacts.GET("", h.GetContacts)
	contacts.POST("/:user_id", h.AddContactAPI)
	contacts.DELETE("/:user_id", h.RemoveContactAPI)

	api.GET("/users/search", h.SearchUsers)
}

func registerUserRoutes(api *gin.RouterGroup, uh *userHandler, wh *webSocketHandler, fh *fileHandler) {
	user := api.Group("/user")
	user.POST("/avatar", uh.UploadAvatar)
	user.DELETE("/avatar", uh.DeleteAvatar)

	unread := api.Group("/unread")
	unread.GET("", wh.GetUnreadMessagesAPI)
	unread.GET("/counts", wh.GetUnreadCountsAPI)

	presence := api.Group("/presence")
	presence.GET("/:user_id", wh.GetUserPresenceAPI)

	api.GET("/files/:filename", fh.ServeFile)
}

func registerClientErrorRoutes(api *gin.RouterGroup, h *clientErrorHandler) {
	api.POST("/client-errors", h.Report)
}

func registerPreferenceRoutes(api *gin.RouterGroup, h *preferenceHandler) {
	prefs := api.Group("/preferences")
	prefs.GET("", h.GetAllPreferencesAPI)
	prefs.PUT("/account", h.UpdateAccountPreferencesAPI)
	prefs.POST("/bulk-apply", h.BulkApplyPreferencesAPI)
	prefs.GET("/chats/:chat_id", h.GetChatPreferenceAPI)
	prefs.PUT("/chats/:chat_id", h.UpdateChatPreferenceAPI)
	prefs.DELETE("/chats/:chat_id", h.ResetChatPreferenceAPI)
}

func registerPushRoutes(api *gin.RouterGroup, h *pushHandler) {
	push := api.Group("/push")
	push.GET("/vapid-key", h.GetVAPIDKey)
	push.POST("/subscribe", h.Subscribe)
	push.POST("/unsubscribe", h.Unsubscribe)
	push.GET("/status", h.GetStatus)
	push.POST("/fcm/register", h.RegisterFCM)
	push.POST("/fcm/unregister", h.UnregisterFCM)
}

//nolint:dupl // See registerChatRoutes.
func registerGroupRoutes(api *gin.RouterGroup, h *groupHandler) {
	groups := api.Group("/groups")
	groups.POST("", h.CreateGroupAPI)
	groups.GET("/:id", h.GetGroupInfoAPI)
	groups.GET("/:id/keys", h.GetGroupKeysAPI)
	groups.PUT("/:id", h.UpdateGroupInfoAPI)
	groups.DELETE("/:id", h.DeleteGroupAPI)
	groups.POST("/:id/avatar", h.UploadGroupAvatarAPI)
	groups.DELETE("/:id/avatar", h.DeleteGroupAvatarAPI)
	groups.POST("/:id/members", h.AddMembersAPI)
	groups.DELETE("/:id/members/:user_id", h.RemoveMemberAPI)
	groups.POST("/:id/leave", h.LeaveGroupAPI)
	groups.PUT("/:id/members/:user_id/role", h.ChangeRoleAPI)
}
