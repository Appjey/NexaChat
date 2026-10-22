package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"strings"
	"time"

	"messenger/internal/models"
	"messenger/internal/repositories"
	"messenger/internal/storage"

	"go.uber.org/zap"
)

// UserService handles business logic for users
type UserService struct {
	logger    *zap.Logger
	userRepo  *repositories.UserRepo
	storage   storage.Storage
	validator *fileValidator
}

// NewUserService creates a new UserService instance
func NewUserService(
	logger *zap.Logger,
	userRepo *repositories.UserRepo,
	fileStorage storage.Storage,
) *UserService {
	return &UserService{
		logger:    logger,
		userRepo:  userRepo,
		storage:   fileStorage,
		validator: &fileValidator{},
	}
}

// UploadAvatar uploads a user avatar
func (s *UserService) UploadAvatar(ctx context.Context, userID uint, fileHeader *multipart.FileHeader) (string, error) {
	// Validate file
	if err := s.validator.validateAvatar(fileHeader); err != nil {
		return "", fmt.Errorf("invalid avatar file: %w", err)
	}

	// Open file
	file, err := fileHeader.Open()
	if err != nil {
		return "", fmt.Errorf("failed to open file: %w", err)
	}
	defer func() { _ = file.Close() }()

	// Get content type
	contentType := fileHeader.Header.Get("Content-Type")

	// Delete old avatar if exists
	user, err := s.userRepo.FindByID(ctx, userID)
	if err != nil {
		return "", fmt.Errorf("find user: %w", err)
	}

	var oldAvatarKey string
	if user.AvatarURL != nil && *user.AvatarURL != "" {
		// Extract storage key from URL if it's a local storage URL
		// For local storage, URL format is: /uploads/avatars/filename
		// We need to extract the key part
		oldAvatarKey = extractStorageKey(*user.AvatarURL)
	}

	// Save to storage with prefix for avatars
	metadata, err := s.storage.Save(
		file,
		"avatar_"+fileHeader.Filename,
		contentType,
		fileHeader.Size,
	)
	if err != nil {
		return "", fmt.Errorf("failed to save avatar: %w", err)
	}

	// Store storage key (not URL) in database - URL will be generated on demand
	avatarKey := metadata.Key

	// Update user avatar in database
	if err := s.userRepo.UpdateAvatar(ctx, userID, &avatarKey); err != nil {
		// Rollback: delete uploaded file
		if delErr := s.storage.Delete(metadata.Key); delErr != nil {
			s.logger.Warn("failed to rollback avatar upload", zap.Error(delErr), zap.String("key", metadata.Key))
		}
		return "", fmt.Errorf("failed to update user avatar: %w", err)
	}

	// Delete old avatar after successful update
	if oldAvatarKey != "" {
		if err := s.storage.Delete(oldAvatarKey); err != nil {
			s.logger.Warn("failed to delete old avatar", zap.Error(err), zap.String("key", oldAvatarKey))
		}
	}

	// Return the generated URL for immediate use
	return s.storage.GetURL(avatarKey), nil
}

// DeleteAvatar removes user avatar
func (s *UserService) DeleteAvatar(ctx context.Context, userID uint) error {
	user, err := s.userRepo.FindByID(ctx, userID)
	if err != nil {
		return fmt.Errorf("find user: %w", err)
	}

	if user.AvatarURL == nil || *user.AvatarURL == "" {
		return errors.New("user has no avatar")
	}

	// Extract storage key from URL
	storageKey := extractStorageKey(*user.AvatarURL)

	// Delete from storage
	if err := s.storage.Delete(storageKey); err != nil {
		// Log error but continue with database update
		s.logger.Warn("failed to delete avatar from storage", zap.Error(err), zap.String("storage_key", storageKey))
	}

	// Update database
	if err := s.userRepo.UpdateAvatar(ctx, userID, nil); err != nil {
		return fmt.Errorf("failed to update user avatar: %w", err)
	}

	return nil
}

// GetAvatarReader returns a reader for user's avatar file
func (s *UserService) GetAvatarReader(ctx context.Context, userID uint) (io.ReadCloser, string, error) {
	user, err := s.userRepo.FindByID(ctx, userID)
	if err != nil {
		return nil, "", fmt.Errorf("find user: %w", err)
	}

	if user.AvatarURL == nil || *user.AvatarURL == "" {
		return nil, "", errors.New("user has no avatar")
	}

	storageKey := extractStorageKey(*user.AvatarURL)
	reader, err := s.storage.Get(storageKey)
	if err != nil {
		return nil, "", fmt.Errorf("failed to get avatar: %w", err)
	}

	// Determine content type from extension
	contentType := "image/jpeg"
	if strings.HasSuffix(strings.ToLower(storageKey), ".png") {
		contentType = "image/png"
	} else if strings.HasSuffix(strings.ToLower(storageKey), ".webp") {
		contentType = "image/webp"
	}

	return reader, contentType, nil
}

// GetUserByID retrieves a user by ID
func (s *UserService) GetUserByID(ctx context.Context, userID uint) (*models.User, error) {
	user, err := s.userRepo.FindByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("user not found: %w", err)
	}
	return user, nil
}

// FindByUsername finds a user by username (case-insensitive)
func (s *UserService) FindByUsername(ctx context.Context, username string) (*models.User, error) {
	// Normalize username to lowercase for case-insensitive lookup
	user, err := s.userRepo.FindByUsername(ctx, strings.ToLower(strings.TrimSpace(username)))
	if err != nil {
		return nil, fmt.Errorf("user not found: %w", err)
	}
	return user, nil
}

// SearchUsers searches for users by username or name. The caller's own user_id is excluded.
func (s *UserService) SearchUsers(ctx context.Context, query string, excludeUserID uint) ([]*models.User, error) {
	users, err := s.userRepo.SearchByUsernameOrName(ctx, query, excludeUserID)
	if err != nil {
		return nil, fmt.Errorf("failed to search users: %w", err)
	}
	return users, nil
}

// UpdateLastSeen persists the moment a user went offline so "last seen" survives
// a server restart or presence-cache eviction. Best-effort: the caller logs and
// continues on error.
func (s *UserService) UpdateLastSeen(ctx context.Context, userID uint, lastSeen time.Time) error {
	return s.userRepo.UpdateLastSeen(ctx, userID, lastSeen)
}

// UpdateProfile updates user's display name
func (s *UserService) UpdateProfile(ctx context.Context, userID uint, name string) error {
	name = strings.TrimSpace(name)
	if len(name) < 2 || len(name) > 50 {
		return fmt.Errorf("name must be 2-50 characters")
	}
	return s.userRepo.UpdateName(ctx, userID, name)
}

// UpdateVault writes the E2E vault material (salt, encrypted account key, public key)
// for a user. All three are opaque base64 strings; the server doesn't inspect them.
//
// Length caps are sanity bounds, not crypto requirements:
//   - vault_salt: ~24 base64 chars for 16 raw bytes, 64 is plenty.
//   - encrypted_account_key: ~120 chars in practice; 4096 leaves headroom.
//   - public_key: X25519 is exactly 44 base64 chars; 64 leaves a tiny bit.
//
// All three move together — partial state lets other users ECDH against a
// public_key whose private half they can't unwrap. We accept "all set" or
// "all cleared" and reject everything in between.
func (s *UserService) UpdateVault(ctx context.Context, userID uint, vaultSalt, encryptedAccountKey, publicKey string) error {
	if len(vaultSalt) > 64 {
		return fmt.Errorf("vault_salt too long")
	}
	if len(encryptedAccountKey) > 4096 {
		return fmt.Errorf("encrypted_account_key too long")
	}
	if len(publicKey) > 64 {
		return fmt.Errorf("public_key too long")
	}
	nonEmpty := 0
	for _, v := range []string{vaultSalt, encryptedAccountKey, publicKey} {
		if v != "" {
			nonEmpty++
		}
	}
	if nonEmpty != 0 && nonEmpty != 3 {
		return fmt.Errorf("vault_salt, encrypted_account_key, and public_key must all be set or all cleared")
	}
	return s.userRepo.UpdateVault(ctx, userID, vaultSalt, encryptedAccountKey, publicKey)
}

// GetAvatarURL returns a presigned URL for the given avatar key
func (s *UserService) GetAvatarURL(avatarKey *string) *string {
	if avatarKey == nil || *avatarKey == "" {
		return nil
	}

	// Check if it's already a full URL (legacy data) or a storage key
	key := *avatarKey
	if strings.HasPrefix(key, "http://") || strings.HasPrefix(key, "https://") {
		// Legacy: extract key from URL
		key = extractStorageKey(key)
	}

	// Use presigned URL — bucket is private, no anonymous access
	url := s.storage.GetURL(key)
	return &url
}

// RefreshUserAvatarURL updates the user's avatar URL to use the API proxy endpoint
func (s *UserService) RefreshUserAvatarURL(user *models.User) {
	if user == nil || user.AvatarURL == nil || *user.AvatarURL == "" {
		return
	}
	// Return API endpoint URL with cache-busting timestamp
	url := fmt.Sprintf("/api/avatars/%d?v=%d", user.ID, user.UpdatedAt.UnixMilli())
	user.AvatarURL = &url
}

// extractStorageKey extracts storage key from URL
// For local storage: http://localhost:8080/uploads/files/2025/12/14/uuid.ext -> files/2025/12/14/uuid.ext
// For S3/MinIO: http://host:9000/bucket-name/files/2025/12/14/uuid.ext -> files/2025/12/14/uuid.ext
func extractStorageKey(url string) string {
	// Check if it's not a URL (already a key)
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return url
	}

	// Try local storage format: /uploads/
	uploadsPrefix := "/uploads/"
	if idx := strings.Index(url, uploadsPrefix); idx != -1 {
		return url[idx+len(uploadsPrefix):]
	}

	// Try S3/MinIO format: /bucket-name/files/ or /bucket-name/avatars/
	// Extract path after bucket name
	for _, prefix := range []string{"/files/", "/avatars/", "/thumbnails/"} {
		if idx := strings.Index(url, prefix); idx != -1 {
			return url[idx+1:] // Include the prefix without leading slash
		}
	}

	// Fallback: try to extract after third slash (scheme://host/bucket/key)
	parts := strings.SplitN(url, "/", 5)
	if len(parts) >= 5 {
		return parts[4] // Return the key part
	}

	return url
}
