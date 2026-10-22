package handlers

import (
	"context"
	"net/http"
	"strings"
	"time"

	"messenger/internal/config"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
)

// sessionValidator answers "may this (session, user) pair still authenticate?".
// Implemented by services.SessionService; tests substitute a stub.
type sessionValidator interface {
	Validate(ctx context.Context, sessionID, userID uint) error
}

// refreshTokenHeader is the response header used to send a freshly-minted token to the
// client when the active token is approaching staleness. The frontend reads this header
// and replaces the stored token, sliding the session forward.
const refreshTokenHeader = "X-Refresh-Token"

// jwtMiddleware returns a Gin middleware for JWT token validation.
//
// Every token must carry a `sid` claim naming an active row in `sessions`
// (see models.Session); `sessions.Validate` is consulted on every request so a
// logout or password change cuts a token off long before its `exp`. Tokens
// minted before sessions existed have no `sid` and are rejected — holders
// simply log in again once.
//
// If `tokenTTL > 0` and the request carries a valid token whose `iat` is older than
// `config.TokenRefreshThresholdSeconds`, the middleware mints a fresh token (same userID
// and session, new exp + new jti) and returns it via the `X-Refresh-Token` response
// header. This implements a sliding session: active users never see their session
// expire, while inactive users still get the full initial TTL window (default 10 years).
//
// Browser clients authenticate with the HttpOnly session cookie (see
// auth_cookie.go). Because a cookie is attached by the browser automatically,
// cookie-authenticated requests that carry an Origin header must come from one
// of allowedOrigins — the same list CORS and the WebSocket upgrade use — which
// closes cross-site request forgery on top of SameSite=Strict.
func jwtMiddleware(secret []byte, log *zap.Logger, tokenTTL time.Duration, sessions sessionValidator, allowedOrigins []string) gin.HandlerFunc {
	originAllowed := make(map[string]struct{}, len(allowedOrigins))
	for _, o := range allowedOrigins {
		if o = strings.TrimSpace(o); o != "" {
			originAllowed[strings.ToLower(o)] = struct{}{}
		}
	}
	publicPaths := map[string]bool{
		"/api/auth/login":    true,
		"/api/auth/register": true,
		"/health":            true,
	}

	// Public path prefixes (attachments are public - no chat membership validation needed)
	publicPrefixes := []string{
		"/api/attachments/",
	}

	return func(c *gin.Context) {
		path := c.Request.URL.Path
		isAPIPath := strings.HasPrefix(path, "/api")
		isWebsocket := strings.HasPrefix(path, "/ws")

		// Allow public endpoints
		if publicPaths[path] {
			c.Next()
			return
		}

		// Allow public prefixes (attachments are validated internally by chat membership)
		for _, prefix := range publicPrefixes {
			if strings.HasPrefix(path, prefix) {
				c.Next()
				return
			}
		}

		tokenString, source := extractToken(c, isAPIPath || isWebsocket)
		if tokenString == "" {
			log.Warn("no token found",
				zap.String("path", path),
				zap.Bool("is_websocket", isWebsocket),
			)
			handleUnauthorized(c)
			return
		}

		// CSRF guard for cookie auth: a browser sends Origin on cross-origin
		// requests and on same-origin non-GET requests; anything not on the
		// allow-list is a foreign page trying to use the user's cookie. (The
		// WebSocket upgrader has its own equivalent check, so /ws is covered too.)
		if source == authSourceCookie {
			if origin := strings.ToLower(strings.TrimSpace(c.GetHeader("Origin"))); origin != "" {
				if _, ok := originAllowed[origin]; !ok {
					log.Warn("cookie auth from disallowed origin", zap.String("path", path), zap.String("origin", origin))
					handleUnauthorized(c)
					return
				}
			}
		}

		token, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
			if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return secret, nil
		})
		if err != nil || !token.Valid {
			log.Warn("invalid token",
				zap.String("path", path),
				zap.Error(err),
			)
			handleUnauthorized(c)
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			handleUnauthorized(c)
			return
		}

		// Validate issuer and audience
		if iss, issOk := claims["iss"].(string); issOk && iss != "messenger-app" {
			log.Warn("invalid issuer", zap.String("iss", iss))
			handleUnauthorized(c)
			return
		}
		if aud, audOk := claims["aud"].(string); audOk && aud != "messenger-users" {
			log.Warn("invalid audience", zap.String("aud", aud))
			handleUnauthorized(c)
			return
		}

		userIDFloat, ok := claims["user_id"].(float64)
		if !ok {
			handleUnauthorized(c)
			return
		}
		userID := uint(userIDFloat)

		sidFloat, ok := claims["sid"].(float64)
		if !ok || sidFloat <= 0 {
			log.Warn("token without session id", zap.String("path", path), zap.Uint("user_id", userID))
			handleUnauthorized(c)
			return
		}
		sessionID := uint(sidFloat)
		if err := sessions.Validate(c.Request.Context(), sessionID, userID); err != nil {
			log.Warn("session rejected",
				zap.String("path", path),
				zap.Uint("user_id", userID),
				zap.Uint("session_id", sessionID),
				zap.Error(err),
			)
			handleUnauthorized(c)
			return
		}

		// Sliding refresh: if the token is older than the threshold, issue a fresh one.
		// Skip for WebSocket upgrades — the response is already a 101 handshake and any
		// X-Refresh-Token header would be invisible to a JS WebSocket client.
		if !isWebsocket {
			maybeRefreshToken(c, secret, userID, sessionID, tokenTTL, claims, log, source)
		}

		c.Set("user_id", userID)
		c.Set("session_id", sessionID)
		c.Set(authSourceKey, source)
		c.Next()
	}
}

// maybeRefreshToken mints a fresh JWT into the X-Refresh-Token response header when the
// active token has been alive longer than the refresh threshold. Pulled out of the
// middleware body so the nested branches don't blow past the nestif threshold.
func maybeRefreshToken(
	c *gin.Context,
	secret []byte,
	userID, sessionID uint,
	tokenTTL time.Duration,
	claims jwt.MapClaims,
	log *zap.Logger,
	source string,
) {
	if tokenTTL <= 0 {
		return
	}
	iatFloat, ok := claims["iat"].(float64)
	if !ok {
		return
	}
	age := time.Now().Unix() - int64(iatFloat)
	if age < config.TokenRefreshThresholdSeconds() {
		return
	}
	fresh, err := issueJWT(secret, userID, sessionID, tokenTTL)
	if err != nil {
		log.Warn("failed to mint refresh token", zap.Error(err))
		return
	}
	// Hand the rotated token back the way it came in: browsers get a new
	// cookie (they never see the token), native clients read the header.
	if source == authSourceCookie {
		setAuthCookie(c, fresh, tokenTTL)
		return
	}
	c.Header(refreshTokenHeader, fresh)
}

// handleUnauthorized responds with JSON
func handleUnauthorized(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "unauthorized"})
}

// extractToken finds the token and reports where it came from: the
// Authorization header (native clients), the HttpOnly session cookie
// (browsers; sent automatically on same-origin fetches and on the WebSocket
// handshake), or — for native WebSocket clients, which cannot set headers —
// the ?token query parameter on /ws.
func extractToken(c *gin.Context, isAPIOrWS bool) (token, source string) {
	authHeader := c.GetHeader("Authorization")
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		return strings.TrimSpace(authHeader[7:]), authSourceBearer
	}

	if cookie := authCookieToken(c); cookie != "" {
		return cookie, authSourceCookie
	}

	if isAPIOrWS && strings.HasPrefix(c.Request.URL.Path, "/ws") {
		if t := c.Query("token"); t != "" {
			return t, authSourceQuery
		}
	}

	return "", ""
}
