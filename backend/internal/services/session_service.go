package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"messenger/internal/models"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// sessionCacheTTL bounds how long a cached "session is active" verdict is
// trusted before the database is consulted again. It is the upper bound on
// how long a revoked token keeps working on a backend instance that did not
// perform the revocation itself (today there is one instance, and it
// invalidates its own cache synchronously, so revocation is immediate).
const sessionCacheTTL = 30 * time.Second

// ErrSessionRevoked is returned by Validate for a session that exists but has
// been revoked (logout / password change).
var ErrSessionRevoked = errors.New("session revoked")

// sessionStore is the persistence surface SessionService needs. Narrow on
// purpose so tests can substitute an in-memory fake.
type sessionStore interface {
	Create(ctx context.Context, session *models.Session) error
	FindByID(ctx context.Context, id uint) (*models.Session, error)
	Revoke(ctx context.Context, sessionID, userID uint, at time.Time) error
	RevokeAllExcept(ctx context.Context, userID, keepID uint, at time.Time) error
}

type sessionCacheEntry struct {
	userID    uint
	expiresAt time.Time
}

// SessionService creates, validates and revokes login sessions. Validation is
// on the hot path (every authenticated request), so positive verdicts are
// memoised for sessionCacheTTL; revocations drop the affected entries right
// away.
type SessionService struct {
	logger *zap.Logger
	store  sessionStore
	now    func() time.Time

	mu    sync.Mutex
	cache map[uint]sessionCacheEntry // sessionID -> active verdict
}

// NewSessionService creates a SessionService backed by the given store.
func NewSessionService(logger *zap.Logger, store sessionStore) *SessionService {
	return &SessionService{
		logger: logger,
		store:  store,
		now:    time.Now,
		cache:  make(map[uint]sessionCacheEntry),
	}
}

// Create opens a new session for the user and returns its id for the `sid`
// JWT claim.
func (s *SessionService) Create(ctx context.Context, userID uint) (uint, error) {
	session := &models.Session{UserID: userID}
	if err := s.store.Create(ctx, session); err != nil {
		return 0, fmt.Errorf("create session: %w", err)
	}
	return session.ID, nil
}

// Validate returns nil when sessionID is an active session belonging to
// userID. Any other outcome — unknown id, revoked, owned by someone else — is
// an error, and the caller must treat the request as unauthenticated.
func (s *SessionService) Validate(ctx context.Context, sessionID, userID uint) error {
	if sessionID == 0 {
		return ErrSessionRevoked
	}

	s.mu.Lock()
	entry, ok := s.cache[sessionID]
	if ok && s.now().Before(entry.expiresAt) {
		s.mu.Unlock()
		if entry.userID != userID {
			return ErrSessionRevoked
		}
		return nil
	}
	delete(s.cache, sessionID)
	s.mu.Unlock()

	session, err := s.store.FindByID(ctx, sessionID)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrSessionRevoked
		}
		return fmt.Errorf("load session: %w", err)
	}
	if session.UserID != userID || !session.IsActive() {
		return ErrSessionRevoked
	}

	s.mu.Lock()
	s.cache[sessionID] = sessionCacheEntry{userID: userID, expiresAt: s.now().Add(sessionCacheTTL)}
	s.mu.Unlock()
	return nil
}

// Revoke ends one session of the user (logout on one device).
func (s *SessionService) Revoke(ctx context.Context, sessionID, userID uint) error {
	if err := s.store.Revoke(ctx, sessionID, userID, s.now()); err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	s.mu.Lock()
	delete(s.cache, sessionID)
	s.mu.Unlock()
	return nil
}

// RevokeOthers ends every session of the user except keepSessionID (password
// change: the device that changed the password stays signed in, everything
// else — including any stolen token — is cut off).
func (s *SessionService) RevokeOthers(ctx context.Context, userID, keepSessionID uint) error {
	if err := s.store.RevokeAllExcept(ctx, userID, keepSessionID, s.now()); err != nil {
		return fmt.Errorf("revoke sessions: %w", err)
	}
	s.mu.Lock()
	for id, entry := range s.cache {
		if entry.userID == userID && id != keepSessionID {
			delete(s.cache, id)
		}
	}
	s.mu.Unlock()
	return nil
}
