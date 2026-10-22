package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"messenger/internal/services"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
)

// authHandler handles HTTP requests for authentication (register, login, logout).
type authHandler struct {
	authService *services.AuthService
	userService *services.UserService
	chatService *services.ChatService
	sessions    *services.SessionService
	limiter     *services.LoginLimiter
	logger      *zap.Logger
	secret      []byte
	tokenTTL    time.Duration
}

// minPasswordLength applies to registration and password change. Existing
// shorter passwords keep working for login; they are only rejected when the
// user next changes their password.
const minPasswordLength = 8

// authHandlerDeps bundles the collaborators of authHandler so the constructor
// doesn't grow a positional parameter per service.
type authHandlerDeps struct {
	Auth     *services.AuthService
	Users    *services.UserService
	Chats    *services.ChatService
	Sessions *services.SessionService
	Limiter  *services.LoginLimiter
	Logger   *zap.Logger
	Secret   []byte
	TokenTTL time.Duration
}

// newAuthHandler creates a new authHandler.
func newAuthHandler(d authHandlerDeps) *authHandler {
	return &authHandler{
		authService: d.Auth,
		userService: d.Users,
		chatService: d.Chats,
		sessions:    d.Sessions,
		limiter:     d.Limiter,
		logger:      d.Logger,
		secret:      d.Secret,
		tokenTTL:    d.TokenTTL,
	}
}

// validatePasswordStrength checks if password meets security requirements
func validatePasswordStrength(password string) error {
	if len(password) < minPasswordLength {
		return fmt.Errorf("password must be at least %d characters", minPasswordLength)
	}
	if strings.TrimSpace(password) == "" {
		return errors.New("password cannot be only whitespace")
	}
	return nil
}

// generateJTI creates a unique JWT ID for token revocation tracking
func generateJTI() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

// openSession starts a new login session for the user (one per device) and
// mints the JWT bound to it. Used by register and login.
func (h *authHandler) openSession(ctx context.Context, userID uint) (string, error) {
	sessionID, err := h.sessions.Create(ctx, userID)
	if err != nil {
		return "", err
	}
	return issueJWT(h.secret, userID, sessionID, h.tokenTTL)
}

// issueJWT mints a new JWT for the given user + session. Shared between the auth
// handler (login/register) and the middleware's sliding-window refresh, which
// keeps the session id so the refreshed token is revoked together with the
// session it belongs to.
func issueJWT(secret []byte, userID, sessionID uint, ttl time.Duration) (string, error) {
	now := time.Now()
	jti, err := generateJTI()
	if err != nil {
		return "", err
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"user_id": userID,
		"sid":     sessionID,
		"iss":     "messenger-app",
		"aud":     "messenger-users",
		"exp":     now.Add(ttl).Unix(),
		"iat":     now.Unix(),
		"jti":     jti,
	})

	return token.SignedString(secret)
}

// RegisterAPI handles JSON registration
func (h *authHandler) RegisterAPI(c *gin.Context) {
	var req struct {
		Username string `json:"username" binding:"required,min=3,max=20"`
		Password string `json:"password" binding:"required,min=8"`
		Name     string `json:"name" binding:"required,min=2,max=50"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		// Parse validation errors
		code, errMsg := codeValidation, "Invalid input data"
		errStr := err.Error()
		if strings.Contains(errStr, "Username") {
			code, errMsg = codeUsernameInvalid, "Username must be 3-20 characters"
		} else if strings.Contains(errStr, "Password") {
			code, errMsg = codeWeakPassword, fmt.Sprintf("Password must be at least %d characters", minPasswordLength)
		} else if strings.Contains(errStr, "Name") {
			code, errMsg = codeNameInvalid, "Name must be 2-50 characters"
		}
		sendError(c, http.StatusBadRequest, code, errMsg)
		return
	}

	// Validate password strength
	if err := validatePasswordStrength(req.Password); err != nil {
		sendError(c, http.StatusBadRequest, codeWeakPassword, err.Error())
		return
	}

	// Validate username format
	usernameRegex := regexp.MustCompile(`^[a-zA-Z0-9_]+$`)
	if !usernameRegex.MatchString(req.Username) {
		sendError(c, http.StatusBadRequest, codeUsernameInvalid, "Username can only contain letters, numbers and underscore")
		return
	}

	req.Name = strings.TrimSpace(req.Name)

	// Validate trimmed name length and content
	if len(req.Name) < 2 {
		sendError(c, http.StatusBadRequest, codeNameInvalid, "Name must be at least 2 characters (excluding spaces)")
		return
	}
	hasAlphanumeric := false
	for _, r := range req.Name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			hasAlphanumeric = true
			break
		}
	}
	if !hasAlphanumeric {
		sendError(c, http.StatusBadRequest, codeNameInvalid, "Name must contain at least one letter or digit")
		return
	}

	err := h.authService.Register(c.Request.Context(), req.Username, req.Password, req.Name)
	if err != nil {
		if strings.Contains(err.Error(), "username") {
			sendError(c, http.StatusBadRequest, codeUsernameTaken, "Username already taken")
		} else {
			sendBadRequest(c, "Registration failed")
		}
		return
	}

	// Auto-login after registration
	user, loginErr := h.authService.Login(c.Request.Context(), req.Username, req.Password)
	if loginErr != nil {
		sendInternalError(c, "Registration successful, but login failed")
		return
	}

	// Create the user's "Saved Messages" self-chat. Idempotent — if it already
	// exists (e.g. duplicate POST), we just get the existing chat back.
	// Failure here is logged but doesn't fail registration: the startup-time
	// backfill will catch any user the in-band creation missed.
	if _, err := h.chatService.EnsureFavoritesChat(c.Request.Context(), user.ID); err != nil {
		// non-fatal — log and continue
		_ = err
	}

	tokenString, err := h.openSession(c.Request.Context(), user.ID)
	if err != nil {
		sendInternalError(c, "Failed to generate token")
		return
	}
	setAuthCookie(c, tokenString, h.tokenTTL)

	sendCreated(c, gin.H{
		"user_id":               user.ID,
		"username":              user.Username,
		"name":                  user.Name,
		"token":                 tokenString,
		"vault_salt":            user.VaultSalt,
		"encrypted_account_key": user.EncryptedAccountKey,
		"public_key":            user.PublicKey,
	})
}

// LoginAPI handles JSON login
func (h *authHandler) LoginAPI(c *gin.Context) {
	var req struct {
		Username string `json:"username" binding:"required"`
		Password string `json:"password" binding:"required"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		sendBadRequest(c, "Invalid input")
		return
	}

	// Brute-force throttle: failed attempts are counted per username and per
	// client IP (trusted-proxy aware, see config.TrustedProxies). The check
	// runs before bcrypt so a locked-out attacker doesn't burn CPU either.
	ip := c.ClientIP()
	if retryAfter, ok := h.limiter.Allow(req.Username, ip); !ok {
		c.Header("Retry-After", strconv.Itoa(int(retryAfter.Seconds())+1))
		c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
			"error": "Too many login attempts, try again later",
			"code":  codeTooManyAttempts,
		})
		return
	}

	user, err := h.authService.Login(c.Request.Context(), req.Username, req.Password)
	if err != nil {
		if h.limiter.RecordFailure(req.Username, ip) {
			h.logger.Warn("login lockout triggered",
				zap.String("username", strings.ToLower(strings.TrimSpace(req.Username))),
				zap.String("ip", ip))
		}
		sendError(c, http.StatusUnauthorized, codeInvalidCredentials, "Invalid username or password")
		return
	}
	h.limiter.RecordSuccess(req.Username)

	tokenString, err := h.openSession(c.Request.Context(), user.ID)
	if err != nil {
		sendInternalError(c, "Failed to generate token")
		return
	}
	// Browser clients authenticate with this cookie from here on and never
	// touch the token in JS; native clients ignore it and use the JSON token.
	setAuthCookie(c, tokenString, h.tokenTTL)

	sendSuccess(c, gin.H{
		"user_id":               user.ID,
		"username":              user.Username,
		"name":                  user.Name,
		"token":                 tokenString,
		"vault_salt":            user.VaultSalt,
		"encrypted_account_key": user.EncryptedAccountKey,
		"public_key":            user.PublicKey,
	})
}

// ChangePasswordAPI handles password change for authenticated users
func (h *authHandler) ChangePasswordAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	var req struct {
		OldPassword string `json:"old_password" binding:"required"`
		NewPassword string `json:"new_password" binding:"required,min=8"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		sendBadRequest(c, "Old password and new password are required")
		return
	}

	if err := validatePasswordStrength(req.NewPassword); err != nil {
		sendError(c, http.StatusBadRequest, codeWeakPassword, err.Error())
		return
	}

	err := h.authService.ChangePassword(c.Request.Context(), userID, req.OldPassword, req.NewPassword)
	if err != nil {
		if errors.Is(err, services.ErrInvalidPassword) {
			sendError(c, http.StatusBadRequest, codeWrongCurrentPassword, "Current password is incorrect")
			return
		}
		sendInternalError(c, "Failed to change password")
		return
	}

	// A password change is the user's "I think my account is compromised"
	// lever: every other device's session is revoked so a stolen token dies
	// here. The session that performed the change stays signed in.
	if err := h.sessions.RevokeOthers(c.Request.Context(), userID, getSessionID(c)); err != nil {
		h.logger.Warn("failed to revoke other sessions after password change",
			zap.Uint("user_id", userID), zap.Error(err))
	}

	sendSuccess(c, gin.H{
		"message": "Password changed successfully",
	})
}

// LogoutAPI revokes the calling session so the token stops working server-side.
// Other devices of the same user are unaffected. Idempotent: logging out an
// already-revoked session still answers 200 so clients can always finish their
// local cleanup.
func (h *authHandler) LogoutAPI(c *gin.Context) {
	// Expire the browser cookie regardless of how the request was
	// authenticated or whether the revoke below succeeds.
	clearAuthCookie(c)
	userID, ok := requireUserID(c)
	if !ok {
		return
	}
	if err := h.sessions.Revoke(c.Request.Context(), getSessionID(c), userID); err != nil {
		h.logger.Error("failed to revoke session on logout",
			zap.Uint("user_id", userID), zap.Error(err))
		sendInternalError(c, "Failed to log out")
		return
	}
	sendSuccess(c, gin.H{
		"message": "Logged out successfully",
	})
}

// GetCurrentUser returns current user info
func (h *authHandler) GetCurrentUser(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	user, err := h.authService.GetUserByID(c.Request.Context(), userID)
	if err != nil {
		sendNotFound(c, "User not found")
		return
	}

	// Refresh avatar URL for S3 presigned URLs
	h.userService.RefreshUserAvatarURL(user)

	// Vault material is included whenever it has been provisioned. Clients use it on
	// app start to derive the vault key, unwrap the account key, and re-derive the
	// X25519 keypair. Absence (all three fields null) means the user hasn't opted
	// into E2E yet — the client prompts for the password until they do.
	sendSuccess(c, gin.H{
		"id":                    user.ID,
		"username":              user.Username,
		"name":                  user.Name,
		"avatar_url":            user.AvatarURL,
		"vault_salt":            user.VaultSalt,
		"encrypted_account_key": user.EncryptedAccountKey,
		"public_key":            user.PublicKey,
	})
}

// UpdateVaultAPI accepts the user's E2E vault material:
//
//   - vault_salt: PBKDF2 salt used to derive vault_key from the password.
//   - encrypted_account_key: account_key sealed under vault_key (AES-GCM).
//   - public_key: X25519 public key derived deterministically from account_key.
//     Published openly so other users can ECDH against it.
//
// All three are stored as opaque base64 strings. The server never sees the
// vault_key, the cleartext account_key, or the X25519 private half.
//
// Pass empty strings for all three to opt out of E2E. Half-state is rejected —
// other users could otherwise ECDH against a public_key that no one can match.
func (h *authHandler) UpdateVaultAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	var req struct {
		VaultSalt           string `json:"vault_salt"`
		EncryptedAccountKey string `json:"encrypted_account_key"`
		PublicKey           string `json:"public_key"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		sendBadRequest(c, "Invalid request body")
		return
	}

	if err := h.userService.UpdateVault(c.Request.Context(), userID, req.VaultSalt, req.EncryptedAccountKey, req.PublicKey); err != nil {
		sendBadRequest(c, err.Error())
		return
	}

	sendSuccess(c, gin.H{"success": true})
}
