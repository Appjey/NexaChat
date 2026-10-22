package services

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"messenger/internal/i18n"
	"messenger/internal/models"
	"messenger/internal/repositories"

	webpush "github.com/SherClockHolmes/webpush-go"
	"go.uber.org/zap"
)

// webpushSendTimeout caps a single WebPush delivery so a slow/hung push endpoint
// doesn't leak goroutines while we keep firing per-subscription sends.
const webpushSendTimeout = 10 * time.Second

// PushPayload represents the JSON payload sent to the browser
type PushPayload struct {
	Title  string `json:"title"`
	Body   string `json:"body"`
	ChatID uint   `json:"chat_id"`
	UserID uint   `json:"user_id"`
	Tag    string `json:"tag,omitempty"`
}

// dismissPayload is the wire shape for a "close notifications for this chat"
// signal. No title / body — the service worker (web) and the Capacitor
// pushNotificationReceived handler (Android) branch on type=="dismiss" and
// call getNotifications + close / removeDeliveredNotifications, without
// showing anything new in the tray.
type dismissPayload struct {
	Type   string `json:"type"`
	ChatID uint   `json:"chat_id"`
	Tag    string `json:"tag"`
}

// callPayload is the wire shape for the "incoming call" doorbell on the web
// (VAPID) channel. The service worker branches on type=="call" and shows a
// notification tagged call-<callID> (excluded from the dismiss sweep); clicking
// it opens the chat. Carries no SDP — it only wakes the callee.
type callPayload struct {
	Type     string `json:"type"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	ChatID   uint   `json:"chat_id"`
	CallID   string `json:"call_id"`
	CallerID uint   `json:"caller_id"`
	Tag      string `json:"tag"`
}

// callPushTTLSeconds caps how long the web push provider keeps an undelivered
// call doorbell queued — short, matching the caller's ring window.
const callPushTTLSeconds = 30

// PushNotificationService fans push notifications out to Web Push (VAPID) and FCM (mobile).
type PushNotificationService struct {
	logger          *zap.Logger
	pushSubRepo     *repositories.PushSubscriptionRepo
	fcm             *FCMService
	httpClient      *http.Client
	vapidPublicKey  string
	vapidPrivateKey string
	vapidSubject    string
	enabled         bool
}

// NewPushNotificationService creates a new push notification service.
// If VAPID keys are not configured, push notifications are disabled (graceful degradation).
func NewPushNotificationService(
	logger *zap.Logger,
	pushSubRepo *repositories.PushSubscriptionRepo,
	vapidPublicKey, vapidPrivateKey, vapidSubject string,
) *PushNotificationService {
	enabled := vapidPublicKey != "" && vapidPrivateKey != "" && vapidSubject != ""
	if !enabled {
		logger.Warn("push notifications disabled: VAPID keys not configured")
	}
	return &PushNotificationService{
		logger:          logger,
		pushSubRepo:     pushSubRepo,
		httpClient:      &http.Client{Timeout: webpushSendTimeout},
		vapidPublicKey:  vapidPublicKey,
		vapidPrivateKey: vapidPrivateKey,
		vapidSubject:    vapidSubject,
		enabled:         enabled,
	}
}

// SetFCMService attaches an FCMService for mobile push fan-out. Optional.
func (s *PushNotificationService) SetFCMService(fcm *FCMService) {
	s.fcm = fcm
}

// IsEnabled returns whether at least one push channel (VAPID or FCM) is configured.
func (s *PushNotificationService) IsEnabled() bool {
	return s.enabled || (s.fcm != nil && s.fcm.IsEnabled())
}

// GetVAPIDPublicKey returns the public key for frontend subscription
func (s *PushNotificationService) GetVAPIDPublicKey() string {
	return s.vapidPublicKey
}

// maxSubscriptionsPerUser is the maximum number of push subscriptions allowed per user.
const maxSubscriptionsPerUser = 10

// Subscribe stores a push subscription for a user.
// Enforces a per-user limit to prevent abuse.
func (s *PushNotificationService) Subscribe(ctx context.Context, userID uint, endpoint, p256dh, auth string) error {
	// Check subscription limit before creating a new one
	count, err := s.pushSubRepo.CountByUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("failed to check subscription count: %w", err)
	}
	if count >= maxSubscriptionsPerUser {
		return fmt.Errorf("subscription limit reached (max %d)", maxSubscriptionsPerUser)
	}

	sub := &models.PushSubscription{
		UserID:   userID,
		Endpoint: endpoint,
		P256dh:   p256dh,
		Auth:     auth,
	}
	return s.pushSubRepo.Upsert(ctx, sub)
}

// Unsubscribe removes a push subscription
func (s *PushNotificationService) Unsubscribe(ctx context.Context, userID uint, endpoint string) error {
	return s.pushSubRepo.DeleteByEndpoint(ctx, userID, endpoint)
}

// HasSubscriptions checks if a user has any push subscriptions
func (s *PushNotificationService) HasSubscriptions(ctx context.Context, userID uint) (bool, error) {
	return s.pushSubRepo.ExistsByUser(ctx, userID)
}

// SendNotification fans a notification out to all Web Push subscriptions and FCM tokens of a user.
func (s *PushNotificationService) SendNotification(ctx context.Context, recipientUserID uint, payload PushPayload) error {
	// FCM fan-out (mobile) runs in parallel to VAPID (web).
	if s.fcm != nil && s.fcm.IsEnabled() {
		if err := s.fcm.SendNotification(ctx, recipientUserID, payload); err != nil {
			s.logger.Warn("FCM fan-out failed", zap.Error(err), zap.Uint("user_id", recipientUserID))
		}
	}

	if !s.enabled {
		return nil
	}

	subs, err := s.pushSubRepo.GetByUser(ctx, recipientUserID)
	if err != nil {
		return fmt.Errorf("failed to get push subscriptions: %w", err)
	}

	if len(subs) == 0 {
		return nil
	}

	s.logger.Info("sending push notification",
		zap.Uint("recipient_id", recipientUserID),
		zap.Int("subscription_count", len(subs)),
	)

	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal push payload: %w", err)
	}

	// Use background context so goroutines don't depend on caller's lifecycle.
	bgCtx := context.Background()
	for _, sub := range subs {
		go s.sendToSubscription(bgCtx, sub, payloadJSON) //nolint:contextcheck // intentionally detached from caller context
	}

	return nil
}

// dismissPushTTL caps how long the push provider should keep an undelivered
// dismiss queued for an offline device. Short on purpose — a dismiss issued
// at t=10 must NOT arrive at t=100 and close a notification for a fresh
// message that arrived at t=50. If the device is offline > a minute, the
// situation has drifted enough that the dismiss is stale; better to drop and
// let the chat-open hook clean up when the user actually comes back online.
const dismissPushTTL = 60

// SendDismiss fans a "dismiss notifications for this chat" data-only push to
// all of recipientUserID's Web Push subscriptions and FCM tokens. Triggered
// when the user reads / opens / deletes their way to "no unread messages
// remaining in chat X" on one device, so the same notification gets
// cleared from the tray on every other device they have.
//
// Idempotent + safe to over-fire: getNotifications + close is a no-op when
// nothing matches the tag (the receiving device might have already cleared
// it via WS handler, OS click dismiss, etc).
func (s *PushNotificationService) SendDismiss(ctx context.Context, recipientUserID, chatID uint) error {
	// FCM fan-out (mobile) runs in parallel to VAPID (web).
	if s.fcm != nil && s.fcm.IsEnabled() {
		if err := s.fcm.SendDismiss(ctx, recipientUserID, chatID); err != nil {
			s.logger.Warn("FCM dismiss fan-out failed", zap.Error(err), zap.Uint("user_id", recipientUserID))
		}
	}

	if !s.enabled {
		return nil
	}

	subs, err := s.pushSubRepo.GetByUser(ctx, recipientUserID)
	if err != nil {
		return fmt.Errorf("failed to get push subscriptions: %w", err)
	}
	if len(subs) == 0 {
		return nil
	}

	payloadJSON, err := json.Marshal(dismissPayload{
		Type:   "dismiss",
		ChatID: chatID,
		Tag:    fmt.Sprintf("chat-%d", chatID),
	})
	if err != nil {
		return fmt.Errorf("failed to marshal dismiss payload: %w", err)
	}

	s.logger.Debug("sending dismiss push",
		zap.Uint("recipient_id", recipientUserID),
		zap.Uint("chat_id", chatID),
		zap.Int("subscription_count", len(subs)),
	)

	bgCtx := context.Background()
	for _, sub := range subs {
		// Short TTL on dismiss so the push provider drops it if the device
		// has been offline more than a minute — see dismissPushTTL above
		// for the race condition this avoids.
		go s.sendToSubscriptionTTL(bgCtx, sub, payloadJSON, dismissPushTTL) //nolint:contextcheck // intentionally detached from caller context
	}
	return nil
}

// SendCallPush fans an "incoming call" doorbell out to all of recipientUserID's
// FCM tokens (mobile) and Web Push subscriptions (web fallback). Best-effort:
// the caller's ring window is the authority on timeout. Carries no SDP — the
// fresh offer is minted over WebSocket once the callee's app is open.
func (s *PushNotificationService) SendCallPush(ctx context.Context, recipientUserID uint, callerName, callID string, chatID, callerID uint) error {
	// FCM fan-out (mobile) runs in parallel to VAPID (web).
	if s.fcm != nil && s.fcm.IsEnabled() {
		if err := s.fcm.SendCallPush(ctx, recipientUserID, callerName, callID, chatID, callerID); err != nil {
			s.logger.Warn("FCM call fan-out failed", zap.Error(err), zap.Uint("user_id", recipientUserID))
		}
	}

	if !s.enabled {
		return nil
	}

	subs, err := s.pushSubRepo.GetByUser(ctx, recipientUserID)
	if err != nil {
		return fmt.Errorf("failed to get push subscriptions: %w", err)
	}
	if len(subs) == 0 {
		return nil
	}

	payloadJSON, err := json.Marshal(callPayload{
		Type:     "call",
		Title:    i18n.IncomingCallTitle,
		Body:     callerName,
		ChatID:   chatID,
		CallID:   callID,
		CallerID: callerID,
		Tag:      fmt.Sprintf("call-%s", callID),
	})
	if err != nil {
		return fmt.Errorf("failed to marshal call payload: %w", err)
	}

	s.logger.Debug("sending call push (web)",
		zap.Uint("recipient_id", recipientUserID),
		zap.String("call_id", callID),
		zap.Int("subscription_count", len(subs)),
	)

	bgCtx := context.Background()
	for _, sub := range subs {
		go s.sendToSubscriptionTTL(bgCtx, sub, payloadJSON, callPushTTLSeconds) //nolint:contextcheck // intentionally detached from caller context
	}
	return nil
}

// sendToSubscription sends push to a single subscription endpoint
// with the default 24-hour TTL (regular messages).
func (s *PushNotificationService) sendToSubscription(ctx context.Context, sub models.PushSubscription, payload []byte) {
	s.sendToSubscriptionTTL(ctx, sub, payload, 86400)
}

// sendToSubscriptionTTL is the parameterized version — dismiss-pushes pass
// a short TTL so a stale dismiss can't close a fresh-message notification.
func (s *PushNotificationService) sendToSubscriptionTTL(ctx context.Context, sub models.PushSubscription, payload []byte, ttl int) {
	subscription := &webpush.Subscription{
		Endpoint: sub.Endpoint,
		Keys: webpush.Keys{
			P256dh: sub.P256dh,
			Auth:   sub.Auth,
		},
	}

	resp, err := webpush.SendNotification(payload, subscription, &webpush.Options{
		HTTPClient:      s.httpClient,
		Subscriber:      s.vapidSubject,
		VAPIDPublicKey:  s.vapidPublicKey,
		VAPIDPrivateKey: s.vapidPrivateKey,
		TTL:             ttl,
		Urgency:         webpush.UrgencyHigh,
	})
	if err != nil {
		s.logger.Error("failed to send push notification",
			zap.Error(err),
			zap.String("endpoint", sub.Endpoint),
			zap.Uint("user_id", sub.UserID),
		)
		return
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusCreated, http.StatusOK:
		s.logger.Debug("push notification delivered",
			zap.Uint("user_id", sub.UserID),
		)
	case http.StatusGone:
		s.logger.Info("push subscription expired, removing",
			zap.String("endpoint", sub.Endpoint),
			zap.Uint("user_id", sub.UserID),
		)
		if err := s.pushSubRepo.DeleteByEndpointGlobal(ctx, sub.Endpoint); err != nil {
			s.logger.Error("failed to remove expired subscription", zap.Error(err))
		}
	case http.StatusNotFound:
		s.logger.Info("push subscription invalid, removing", zap.String("endpoint", sub.Endpoint))
		if err := s.pushSubRepo.DeleteByEndpointGlobal(ctx, sub.Endpoint); err != nil {
			s.logger.Error("failed to remove invalid subscription", zap.Error(err))
		}
	default:
		s.logger.Warn("unexpected push response",
			zap.Int("status", resp.StatusCode),
			zap.String("endpoint", sub.Endpoint),
		)
	}
}
