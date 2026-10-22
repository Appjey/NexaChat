package models

import (
	"time"

	"gorm.io/gorm"
)

// Session is one login on one device. Every JWT carries the session id in its
// `sid` claim, and the auth middleware refuses tokens whose session has been
// revoked. This is what makes long-lived tokens (see config.defaultJWTExpiryDays)
// revocable at all:
//
//   - logout revokes the calling session only, so the user's other devices stay
//     signed in;
//   - a password change revokes every other session of the user, so a stolen
//     token dies the moment the owner rotates their password;
//   - the sliding-window refresh keeps the same session id, so a refreshed token
//     is revoked together with the one it replaced.
//
// Rows are never deleted — a revoked session is a tombstone that keeps the
// stale token rejected until the token itself expires.
type Session struct {
	gorm.Model
	UserID    uint       `gorm:"index:idx_sessions_user;not null"`
	RevokedAt *time.Time `gorm:"index"`
}

// IsActive reports whether the session can still authenticate requests.
func (s *Session) IsActive() bool {
	return s.RevokedAt == nil
}
