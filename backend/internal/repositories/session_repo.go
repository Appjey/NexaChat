package repositories

import (
	"context"
	"time"

	"messenger/internal/models"

	"gorm.io/gorm"
)

// SessionRepo handles database operations for login sessions.
type SessionRepo struct {
	db *gorm.DB
}

// NewSessionRepo creates a new SessionRepo instance.
func NewSessionRepo(db *gorm.DB) *SessionRepo {
	return &SessionRepo{db: db}
}

// Create stores a new session row and fills in its ID.
func (r *SessionRepo) Create(ctx context.Context, session *models.Session) error {
	return r.db.WithContext(ctx).Create(session).Error
}

// FindByID loads a session by its primary key. Returns gorm.ErrRecordNotFound
// when the id is unknown.
func (r *SessionRepo) FindByID(ctx context.Context, id uint) (*models.Session, error) {
	var s models.Session
	if err := r.db.WithContext(ctx).First(&s, id).Error; err != nil {
		return nil, err
	}
	return &s, nil
}

// Revoke marks one session of the user as revoked. Scoped by user_id so a
// caller can never revoke somebody else's session by guessing an id. Already
// revoked sessions are left untouched (revoked_at keeps the original moment).
func (r *SessionRepo) Revoke(ctx context.Context, sessionID, userID uint, at time.Time) error {
	return r.db.WithContext(ctx).Model(&models.Session{}).
		Where("id = ? AND user_id = ? AND revoked_at IS NULL", sessionID, userID).
		Update("revoked_at", at).Error
}

// RevokeAllExcept revokes every active session of the user other than keepID.
// Pass keepID = 0 to revoke all of them.
func (r *SessionRepo) RevokeAllExcept(ctx context.Context, userID, keepID uint, at time.Time) error {
	q := r.db.WithContext(ctx).Model(&models.Session{}).
		Where("user_id = ? AND revoked_at IS NULL", userID)
	if keepID != 0 {
		q = q.Where("id <> ?", keepID)
	}
	return q.Update("revoked_at", at).Error
}
