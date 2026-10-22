package services

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"messenger/internal/i18n"
	"messenger/internal/models"
	"messenger/internal/repositories"

	firebase "firebase.google.com/go/v4"
	"firebase.google.com/go/v4/messaging"
	"go.uber.org/zap"
	"google.golang.org/api/option"
)

// fcmSendTimeout caps a single FCM Send call so a hung Firebase connection
// doesn't leak goroutines indefinitely.
const fcmSendTimeout = 10 * time.Second

// maxFCMTokensPerUser limits how many device tokens a user can register.
const maxFCMTokensPerUser = 10

// FCMService sends push notifications via Firebase Cloud Messaging.
// If credentials are not configured, the service is disabled (graceful degradation).
type FCMService struct {
	logger    *zap.Logger
	tokenRepo *repositories.FCMTokenRepo
	client    *messaging.Client
	enabled   bool
}

// NewFCMService initializes the Firebase app from a service account JSON file.
// If credentialsPath is empty or init fails, the service runs in disabled mode.
func NewFCMService(logger *zap.Logger, tokenRepo *repositories.FCMTokenRepo, credentialsPath string) *FCMService {
	s := &FCMService{logger: logger, tokenRepo: tokenRepo}

	if credentialsPath == "" {
		logger.Warn("FCM disabled: FCM_CREDENTIALS_PATH not set")
		return s
	}

	app, err := firebase.NewApp(context.Background(), nil, option.WithCredentialsFile(credentialsPath))
	if err != nil {
		logger.Error("FCM disabled: failed to init Firebase app", zap.Error(err))
		return s
	}

	client, err := app.Messaging(context.Background())
	if err != nil {
		logger.Error("FCM disabled: failed to get messaging client", zap.Error(err))
		return s
	}

	s.client = client
	s.enabled = true
	logger.Info("FCM initialized")
	return s
}

// IsEnabled returns whether FCM is configured and ready.
func (s *FCMService) IsEnabled() bool {
	return s.enabled
}

// Register stores an FCM token for a user, enforcing a per-user cap.
func (s *FCMService) Register(ctx context.Context, userID uint, token, platform string) error {
	count, err := s.tokenRepo.CountByUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("failed to check FCM token count: %w", err)
	}
	if count >= maxFCMTokensPerUser {
		return fmt.Errorf("FCM token limit reached (max %d)", maxFCMTokensPerUser)
	}

	return s.tokenRepo.Upsert(ctx, &models.FCMToken{
		UserID:   userID,
		Token:    token,
		Platform: platform,
	})
}

// Unregister removes an FCM token for a user.
func (s *FCMService) Unregister(ctx context.Context, userID uint, token string) error {
	return s.tokenRepo.DeleteByToken(ctx, userID, token)
}

// HasTokens checks if the user has any FCM tokens registered.
func (s *FCMService) HasTokens(ctx context.Context, userID uint) (bool, error) {
	count, err := s.tokenRepo.CountByUser(ctx, userID)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// SendNotification delivers a notification to every FCM token registered for recipientUserID.
// Invalid/unregistered tokens are pruned automatically.
func (s *FCMService) SendNotification(ctx context.Context, recipientUserID uint, payload PushPayload) error {
	if !s.enabled {
		return nil
	}

	tokens, err := s.tokenRepo.GetByUser(ctx, recipientUserID)
	if err != nil {
		return fmt.Errorf("failed to get FCM tokens: %w", err)
	}
	if len(tokens) == 0 {
		return nil
	}

	s.logger.Info("sending FCM notification",
		zap.Uint("recipient_id", recipientUserID),
		zap.Int("token_count", len(tokens)),
	)

	bgCtx := context.Background()
	for _, t := range tokens {
		go s.sendToToken(bgCtx, t, payload) //nolint:contextcheck // detached from caller
	}
	return nil
}

// SendDismiss delivers a data-only FCM message to every registered token of
// recipientUserID. The receiving Capacitor handler branches on
// data.type=="dismiss" and calls removeDeliveredNotifications for any
// tray entries with tag "chat-<chatID>". Data-only (no Notification field)
// is required so the message hits the app's onMessageReceived path in
// background as well as foreground; if we set Notification here, Android
// would auto-display it and our handler wouldn't see it until tap.
//
// Caveat: force-stopped Android apps don't receive data-only messages —
// the tray entry stays until the user next opens the app, at which point
// the WS reconnect + chat-open hook will catch up. Same trade-off
// every messenger has on Android.
func (s *FCMService) SendDismiss(ctx context.Context, recipientUserID, chatID uint) error {
	if !s.enabled {
		return nil
	}

	tokens, err := s.tokenRepo.GetByUser(ctx, recipientUserID)
	if err != nil {
		return fmt.Errorf("failed to get FCM tokens: %w", err)
	}
	if len(tokens) == 0 {
		return nil
	}

	s.logger.Debug("sending FCM dismiss",
		zap.Uint("recipient_id", recipientUserID),
		zap.Uint("chat_id", chatID),
		zap.Int("token_count", len(tokens)),
	)

	bgCtx := context.Background()
	for _, t := range tokens {
		go s.sendDismissToToken(bgCtx, t, chatID) //nolint:contextcheck // detached from caller
	}
	return nil
}

// sendDismissToToken sends one data-only FCM message and prunes invalid tokens.
func (s *FCMService) sendDismissToToken(ctx context.Context, t models.FCMToken, chatID uint) {
	defer func() {
		if r := recover(); r != nil {
			s.logger.Error("panic in FCM dismiss goroutine", zap.Any("panic", r))
		}
	}()

	// Short TTL so a stale dismiss can't close a notification for a
	// brand-new message the user actually wants to see. If the device is
	// offline > 60s the dismiss is dropped at FCM-server-side; the
	// chat-open hook will catch up when the user actually comes back.
	ttl := time.Minute
	msg := &messaging.Message{
		Token: t.Token,
		// No Notification — pure data so the receiver handler always fires,
		// not Android's auto-display path.
		Data: map[string]string{
			"type":    "dismiss",
			"chat_id": strconv.FormatUint(uint64(chatID), 10),
			"tag":     fmt.Sprintf("chat-%d", chatID),
		},
		Android: &messaging.AndroidConfig{
			// high priority so Doze / battery saver don't bury the dismiss
			// for tens of minutes — dismiss is meant to feel near-instant.
			Priority: "high",
			TTL:      &ttl,
		},
	}

	sendCtx, cancel := context.WithTimeout(ctx, fcmSendTimeout)
	defer cancel()

	if _, err := s.client.Send(sendCtx, msg); err != nil {
		if messaging.IsUnregistered(err) || messaging.IsInvalidArgument(err) {
			s.logger.Info("FCM token invalid on dismiss, removing",
				zap.Uint("user_id", t.UserID),
			)
			if delErr := s.tokenRepo.DeleteByTokenGlobal(ctx, t.Token); delErr != nil {
				s.logger.Error("failed to prune invalid FCM token", zap.Error(delErr))
			}
			return
		}
		s.logger.Warn("FCM dismiss send failed", zap.Error(err), zap.Uint("user_id", t.UserID))
	}
}

// callPushTTL caps how long FCM keeps an undelivered call doorbell queued. Kept
// short — slightly under the caller's ring window — so a stale doorbell can't
// ring the callee long after the caller gave up.
const callPushTTL = 30 * time.Second

// SendCallPush delivers an "incoming call" doorbell notification to every token
// of recipientUserID, high-priority (wakes the device from Doze) with a distinct
// call-<callID> tag so it's never swept by the chat-<id> dismiss handlers.
// Carries no SDP — it only wakes the callee so the re-offer handshake can run
// over WebSocket once the app is open.
func (s *FCMService) SendCallPush(ctx context.Context, recipientUserID uint, callerName, callID string, chatID, callerID uint) error {
	if !s.enabled {
		return nil
	}
	tokens, err := s.tokenRepo.GetByUser(ctx, recipientUserID)
	if err != nil {
		return fmt.Errorf("failed to get FCM tokens: %w", err)
	}
	if len(tokens) == 0 {
		return nil
	}

	s.logger.Info("sending FCM call push",
		zap.Uint("recipient_id", recipientUserID),
		zap.String("call_id", callID),
		zap.Int("token_count", len(tokens)),
	)

	bgCtx := context.Background()
	for _, t := range tokens {
		go s.sendCallToToken(bgCtx, t, callerName, callID, chatID, callerID) //nolint:contextcheck // detached from caller
	}
	return nil
}

// sendCallToToken sends one call doorbell and prunes invalid tokens.
func (s *FCMService) sendCallToToken(ctx context.Context, t models.FCMToken, callerName, callID string, chatID, callerID uint) {
	defer func() {
		if r := recover(); r != nil {
			s.logger.Error("panic in FCM call goroutine", zap.Any("panic", r))
		}
	}()

	ttl := callPushTTL
	tag := fmt.Sprintf("call-%s", callID)
	msg := &messaging.Message{
		Token: t.Token,
		Notification: &messaging.Notification{
			Title: i18n.IncomingCallTitle,
			Body:  callerName,
		},
		Data: map[string]string{
			"type":      "call",
			"call_id":   callID,
			"chat_id":   strconv.FormatUint(uint64(chatID), 10),
			"caller_id": strconv.FormatUint(uint64(callerID), 10),
			"tag":       tag,
		},
		Android: &messaging.AndroidConfig{
			Priority: "high",
			TTL:      &ttl,
			Notification: &messaging.AndroidNotification{
				Tag: tag,
				// Reuse the known-good "messages" channel rather than a dedicated
				// "calls" one: the app registers no channels, so an unknown
				// channel id would fall back to *default* importance on Android
				// O+ (no heads-up). "messages" is what working notifications use.
				// A dedicated high-importance calls channel is a follow-up that
				// needs native createChannel registration first.
				ChannelID: "messages",
			},
		},
	}

	sendCtx, cancel := context.WithTimeout(ctx, fcmSendTimeout)
	defer cancel()

	if _, err := s.client.Send(sendCtx, msg); err != nil {
		if messaging.IsUnregistered(err) || messaging.IsInvalidArgument(err) {
			s.logger.Info("FCM token invalid on call push, removing", zap.Uint("user_id", t.UserID))
			if delErr := s.tokenRepo.DeleteByTokenGlobal(ctx, t.Token); delErr != nil {
				s.logger.Error("failed to prune invalid FCM token", zap.Error(delErr))
			}
			return
		}
		s.logger.Warn("FCM call push failed", zap.Error(err), zap.Uint("user_id", t.UserID))
	}
}

// sendToToken delivers to a single device token and prunes on permanent failure.
func (s *FCMService) sendToToken(ctx context.Context, t models.FCMToken, payload PushPayload) {
	defer func() {
		if r := recover(); r != nil {
			s.logger.Error("panic in FCM goroutine", zap.Any("panic", r))
		}
	}()

	msg := &messaging.Message{
		Token: t.Token,
		Notification: &messaging.Notification{
			Title: payload.Title,
			Body:  payload.Body,
		},
		Data: map[string]string{
			"chat_id": strconv.FormatUint(uint64(payload.ChatID), 10),
			"user_id": strconv.FormatUint(uint64(payload.UserID), 10),
			"tag":     payload.Tag,
		},
		Android: &messaging.AndroidConfig{
			Priority: "high",
			Notification: &messaging.AndroidNotification{
				Tag:       payload.Tag,
				ChannelID: "messages",
				// No ClickAction: Capacitor's MainActivity has no custom intent-filter, so the
				// notification tap must resolve to the default LAUNCHER intent (null click_action)
				// and flow through to pushNotificationActionPerformed.
			},
		},
	}

	sendCtx, cancel := context.WithTimeout(ctx, fcmSendTimeout)
	defer cancel()

	if _, err := s.client.Send(sendCtx, msg); err != nil {
		if messaging.IsUnregistered(err) || messaging.IsInvalidArgument(err) {
			s.logger.Info("FCM token invalid, removing",
				zap.Uint("user_id", t.UserID),
			)
			if delErr := s.tokenRepo.DeleteByTokenGlobal(ctx, t.Token); delErr != nil {
				s.logger.Error("failed to prune invalid FCM token", zap.Error(delErr))
			}
			return
		}
		s.logger.Warn("FCM send failed", zap.Error(err), zap.Uint("user_id", t.UserID))
		return
	}
	s.logger.Debug("FCM notification delivered", zap.Uint("user_id", t.UserID))
}
