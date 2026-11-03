package repositories

import (
	"context"
	"errors"

	"messenger/internal/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrPreferenceVersionConflict is returned when a CAS update fails because
// the stored version does not match the caller's expected version.
var ErrPreferenceVersionConflict = errors.New("preference version conflict")

// PreferenceRepo handles persistence for UserPreference and UserChatPreference.
type PreferenceRepo struct {
	db *gorm.DB
}

// NewPreferenceRepo creates a new PreferenceRepo.
func NewPreferenceRepo(db *gorm.DB) *PreferenceRepo {
	return &PreferenceRepo{db: db}
}

// WithTx returns a new PreferenceRepo scoped to the given transaction.
func (r *PreferenceRepo) WithTx(tx *gorm.DB) *PreferenceRepo {
	return &PreferenceRepo{db: tx}
}

// GetAccountPref returns the user's account preference row, or gorm.ErrRecordNotFound if none exists yet.
func (r *PreferenceRepo) GetAccountPref(ctx context.Context, userID uint) (*models.UserPreference, error) {
	var pref models.UserPreference
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&pref).Error; err != nil {
		return nil, err
	}
	return &pref, nil
}

// UpsertAccountPrefCAS atomically inserts or updates the user's account preferences.
// If expectedVersion > 0, it enforces Compare-And-Swap (version == expectedVersion).
// If expectedVersion == 0, it inserts when no row exists (or updates only if version == 0).
// On conflict, returns ErrPreferenceVersionConflict along with the current row.
func (r *PreferenceRepo) UpsertAccountPrefCAS(
	ctx context.Context,
	next *models.UserPreference,
	expectedVersion int64,
) (*models.UserPreference, error) {
	var out *models.UserPreference
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current models.UserPreference
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ?", next.UserID).
			First(&current).Error

		if errors.Is(err, gorm.ErrRecordNotFound) {
			if expectedVersion != 0 {
				out = models.DefaultUserPreference(next.UserID)
				return ErrPreferenceVersionConflict
			}
			next.Version = 1
			if err := tx.Create(next).Error; err != nil {
				return err
			}
			out = next
			return nil
		}
		if err != nil {
			return err
		}

		// Idempotency check: if the same idempotency key was already applied, return current state as success.
		if next.LastIdempotencyKey != "" && current.LastIdempotencyKey == next.LastIdempotencyKey {
			out = &current
			return nil
		}

		if current.Version != expectedVersion {
			out = &current
			return ErrPreferenceVersionConflict
		}

		next.Version = current.Version + 1
		if err := tx.Save(next).Error; err != nil {
			return err
		}
		out = next
		return nil
	})
	return out, err
}

// GetChatPref returns the per-user per-chat preference row, or gorm.ErrRecordNotFound.
func (r *PreferenceRepo) GetChatPref(ctx context.Context, userID, chatID uint) (*models.UserChatPreference, error) {
	var pref models.UserChatPreference
	if err := r.db.WithContext(ctx).
		Where("user_id = ? AND chat_id = ?", userID, chatID).
		First(&pref).Error; err != nil {
		return nil, err
	}
	return &pref, nil
}

// ListChatPrefs returns all per-chat preference rows for a user.
func (r *PreferenceRepo) ListChatPrefs(ctx context.Context, userID uint) ([]models.UserChatPreference, error) {
	var prefs []models.UserChatPreference
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("chat_id ASC").
		Find(&prefs).Error; err != nil {
		return nil, err
	}
	return prefs, nil
}

// UpsertChatPrefCAS atomically inserts or updates a per-user per-chat preference row.
// If expectedVersion >= 0, enforces CAS (current.Version == expectedVersion, where non-existent row has Version 0).
// If expectedVersion < 0, performs an unconditional upsert (used by bulk apply when the caller doesn't pass per-chat CAS versions, or when resetting).
func (r *PreferenceRepo) UpsertChatPrefCAS(
	ctx context.Context,
	userID, chatID uint,
	expectedVersion int64,
	idempotencyKey string,
	mutate func(current *models.UserChatPreference),
) (*models.UserChatPreference, error) {
	var out *models.UserChatPreference
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		current, isNew, err := loadOrInitChatPref(tx, userID, chatID)
		if err != nil {
			return err
		}
		if !isNew && idempotencyKey != "" && current.LastIdempotencyKey == idempotencyKey {
			out = current
			return nil
		}
		if expectedVersion >= 0 && current.Version != expectedVersion {
			cp := *current
			out = &cp
			return ErrPreferenceVersionConflict
		}

		mutate(current)
		current.UserID = userID
		current.ChatID = chatID
		current.Version++
		if idempotencyKey != "" {
			current.LastIdempotencyKey = idempotencyKey
		}

		if err := persistChatPref(tx, current, isNew); err != nil {
			return err
		}
		out = current
		return nil
	})
	return out, err
}

func loadOrInitChatPref(tx *gorm.DB, userID, chatID uint) (*models.UserChatPreference, bool, error) {
	var current models.UserChatPreference
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("user_id = ? AND chat_id = ?", userID, chatID).
		First(&current).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return models.DefaultUserChatPreference(userID, chatID), true, nil
	}
	if err != nil {
		return nil, false, err
	}
	return &current, false, nil
}

func persistChatPref(tx *gorm.DB, current *models.UserChatPreference, isNew bool) error {
	if isNew {
		return tx.Create(current).Error
	}
	return tx.Save(current).Error
}

// DeleteByChat removes all per-user preference rows when a chat is deleted.
func (r *PreferenceRepo) DeleteByChat(ctx context.Context, chatID uint) error {
	return r.db.WithContext(ctx).Where("chat_id = ?", chatID).Delete(&models.UserChatPreference{}).Error
}
