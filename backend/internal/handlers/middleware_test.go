package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"messenger/internal/services"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"go.uber.org/zap"
)

var testSecret = []byte("test-secret-key-for-jwt-middleware-testing")

// testOrigins is the allow-list cookie-authenticated requests are checked against.
var testOrigins = []string{"https://app.example"}

// sessionCookie builds the request-side session cookie as a browser would send it.
func sessionCookie(value string) *http.Cookie {
	return &http.Cookie{Name: authCookieName, Value: value, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode}
}

// testSessionID is the session every validClaims token belongs to.
const testSessionID = 1

// allowAllSessions accepts every (session, user) pair — the middleware tests
// below are about the JWT itself, not about revocation.
type allowAllSessions struct{}

func (allowAllSessions) Validate(context.Context, uint, uint) error { return nil }

// revokedSessions rejects every session, simulating logout / password change.
type revokedSessions struct{}

func (revokedSessions) Validate(context.Context, uint, uint) error {
	return services.ErrSessionRevoked
}

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	os.Exit(m.Run())
}

// createTestToken generates a signed JWT with the given claims and secret.
func createTestToken(t *testing.T, claims jwt.MapClaims, secret []byte) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(secret)
	if err != nil {
		t.Fatalf("failed to sign test token: %v", err)
	}
	return signed
}

// validClaims returns standard valid claims for testing.
func validClaims(userID float64) jwt.MapClaims {
	now := time.Now()
	return jwt.MapClaims{
		"user_id": userID,
		"sid":     float64(testSessionID),
		"iss":     "messenger-app",
		"aud":     "messenger-users",
		"exp":     now.Add(time.Hour).Unix(),
		"iat":     now.Unix(),
	}
}

// setupMiddlewareTest creates a Gin engine with the JWT middleware and a test handler.
// The test handler returns 200 with the user_id from context.
func setupMiddlewareTest() *gin.Engine {
	r := gin.New()
	logger := zap.NewNop()
	r.Use(jwtMiddleware(testSecret, logger, 0, allowAllSessions{}, testOrigins))
	r.GET("/api/test", func(c *gin.Context) {
		userID, exists := c.Get("user_id")
		if !exists {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "user_id not set"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"user_id": userID, "session_id": getSessionID(c)})
	})
	return r
}

func TestJWTMiddleware_MissingSessionClaim(t *testing.T) {
	r := setupMiddlewareTest()

	claims := validClaims(42)
	delete(claims, "sid")
	token := createTestToken(t, claims, testSecret)

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d (legacy token without sid must be rejected)", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTMiddleware_RevokedSession(t *testing.T) {
	r := gin.New()
	r.Use(jwtMiddleware(testSecret, zap.NewNop(), 0, revokedSessions{}, testOrigins))
	r.GET("/api/test", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	token := createTestToken(t, validClaims(42), testSecret)
	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d for a revoked session", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTMiddleware_SessionIDInContext(t *testing.T) {
	r := setupMiddlewareTest()
	token := createTestToken(t, validClaims(42), testSecret)

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusOK, w.Body.String())
	}
	if want := `"session_id":1`; !strings.Contains(w.Body.String(), want) {
		t.Fatalf("body %s does not contain %s", w.Body.String(), want)
	}
}

func TestJWTMiddleware_ValidToken(t *testing.T) {
	r := setupMiddlewareTest()
	token := createTestToken(t, validClaims(42), testSecret)

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusOK, w.Body.String())
	}
}

func TestJWTMiddleware_MissingToken(t *testing.T) {
	r := setupMiddlewareTest()

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTMiddleware_ExpiredToken(t *testing.T) {
	r := setupMiddlewareTest()

	claims := validClaims(42)
	claims["exp"] = time.Now().Add(-time.Hour).Unix() // expired
	token := createTestToken(t, claims, testSecret)

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTMiddleware_InvalidSignature(t *testing.T) {
	r := setupMiddlewareTest()

	// Sign with a different secret
	wrongSecret := []byte("wrong-secret-key-that-does-not-match!!")
	token := createTestToken(t, validClaims(42), wrongSecret)

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTMiddleware_WrongIssuer(t *testing.T) {
	r := setupMiddlewareTest()

	claims := validClaims(42)
	claims["iss"] = "wrong-issuer"
	token := createTestToken(t, claims, testSecret)

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTMiddleware_WrongAudience(t *testing.T) {
	r := setupMiddlewareTest()

	claims := validClaims(42)
	claims["aud"] = "wrong-audience"
	token := createTestToken(t, claims, testSecret)

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTMiddleware_MissingUserIDClaim(t *testing.T) {
	r := setupMiddlewareTest()

	claims := validClaims(42)
	delete(claims, "user_id")
	token := createTestToken(t, claims, testSecret)

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestJWTMiddleware_PublicPathSkipped(t *testing.T) {
	r := gin.New()
	logger := zap.NewNop()
	r.Use(jwtMiddleware(testSecret, logger, 0, allowAllSessions{}, testOrigins))

	// Register all public paths and prefixes. Logout is deliberately absent:
	// it needs the token to know which session to revoke.
	publicPaths := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/auth/login"},
		{http.MethodPost, "/api/auth/register"},
		{http.MethodGet, "/health"},
		{http.MethodGet, "/api/attachments/123"},
		{http.MethodGet, "/api/attachments/some-file.jpg"},
	}

	for _, pp := range publicPaths {
		switch pp.method {
		case http.MethodGet:
			r.GET(pp.path, func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{"status": "ok"})
			})
		case http.MethodPost:
			r.POST(pp.path, func(c *gin.Context) {
				c.JSON(http.StatusOK, gin.H{"status": "ok"})
			})
		}
	}

	for _, pp := range publicPaths {
		t.Run(pp.method+" "+pp.path, func(t *testing.T) {
			req := httptest.NewRequest(pp.method, pp.path, http.NoBody)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Errorf("status = %d, want %d", w.Code, http.StatusOK)
			}
		})
	}
}

func TestJWTMiddleware_MalformedAuthorizationHeader(t *testing.T) {
	r := setupMiddlewareTest()

	tests := []struct {
		name   string
		header string
	}{
		{"empty header", ""},
		{"no bearer prefix", "Token abc123"},
		{"bearer only", "Bearer "},
		{"lowercase bearer with garbage", "bearer not-a-jwt"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
			}
		})
	}
}

// TestJWTMiddleware_SlidingRefresh verifies the middleware emits a fresh token in the
// X-Refresh-Token response header when the active token is older than the refresh
// threshold. This is what keeps active users' sessions from expiring.
func TestJWTMiddleware_SlidingRefresh(t *testing.T) {
	r := gin.New()
	logger := zap.NewNop()
	r.Use(jwtMiddleware(testSecret, logger, time.Hour*24*365, allowAllSessions{}, testOrigins))
	r.GET("/api/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	t.Run("stale token gets refreshed", func(t *testing.T) {
		claims := validClaims(42)
		// iat well past the 24h refresh threshold
		claims["iat"] = time.Now().Add(-48 * time.Hour).Unix()
		claims["exp"] = time.Now().Add(time.Hour).Unix() // still valid
		token := createTestToken(t, claims, testSecret)

		req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}
		refreshed := w.Header().Get("X-Refresh-Token")
		if refreshed == "" {
			t.Fatal("expected X-Refresh-Token header, got empty")
		}
		if refreshed == token {
			t.Fatal("expected a freshly-minted token distinct from the request token")
		}
		// The refreshed token must stay bound to the same session so revoking
		// that session kills both the old and the refreshed token.
		parsed, err := jwt.Parse(refreshed, func(*jwt.Token) (interface{}, error) { return testSecret, nil })
		if err != nil {
			t.Fatalf("parse refreshed token: %v", err)
		}
		if sid, _ := parsed.Claims.(jwt.MapClaims)["sid"].(float64); sid != testSessionID {
			t.Fatalf("refreshed sid = %v, want %d", sid, testSessionID)
		}
	})

	t.Run("fresh token is not rotated", func(t *testing.T) {
		token := createTestToken(t, validClaims(42), testSecret)

		req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}
		if got := w.Header().Get("X-Refresh-Token"); got != "" {
			t.Fatalf("X-Refresh-Token = %q, want empty", got)
		}
	})

	t.Run("refresh skipped when ttl is zero", func(t *testing.T) {
		rNoRefresh := gin.New()
		rNoRefresh.Use(jwtMiddleware(testSecret, logger, 0, allowAllSessions{}, testOrigins))
		rNoRefresh.GET("/api/test", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{"ok": true})
		})

		claims := validClaims(42)
		claims["iat"] = time.Now().Add(-48 * time.Hour).Unix()
		claims["exp"] = time.Now().Add(time.Hour).Unix()
		token := createTestToken(t, claims, testSecret)

		req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		rNoRefresh.ServeHTTP(w, req)

		if got := w.Header().Get("X-Refresh-Token"); got != "" {
			t.Fatalf("X-Refresh-Token = %q, want empty when ttl is zero", got)
		}
	})
}

func TestJWTMiddleware_WebSocketQueryToken(t *testing.T) {
	r := gin.New()
	logger := zap.NewNop()
	r.Use(jwtMiddleware(testSecret, logger, 0, allowAllSessions{}, testOrigins))
	r.GET("/ws", func(c *gin.Context) {
		userID, exists := c.Get("user_id")
		if !exists {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "user_id not set"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"user_id": userID})
	})

	token := createTestToken(t, validClaims(7), testSecret)

	t.Run("valid token in query param", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/ws?token="+token, http.NoBody)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Errorf("status = %d, want %d; body: %s", w.Code, http.StatusOK, w.Body.String())
		}
	})

	t.Run("missing token in query param", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/ws", http.NoBody)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)

		if w.Code != http.StatusUnauthorized {
			t.Errorf("status = %d, want %d", w.Code, http.StatusUnauthorized)
		}
	})
}

func TestJWTMiddleware_CookieAuth(t *testing.T) {
	r := setupMiddlewareTest()
	token := createTestToken(t, validClaims(42), testSecret)

	t.Run("cookie alone authenticates", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
		req.AddCookie(sessionCookie(token))
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body: %s", w.Code, http.StatusOK, w.Body.String())
		}
	})

	t.Run("cookie with allowed Origin passes", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
		req.AddCookie(sessionCookie(token))
		req.Header.Set("Origin", "https://App.Example")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}
	})

	t.Run("cookie with foreign Origin is rejected (CSRF)", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
		req.AddCookie(sessionCookie(token))
		req.Header.Set("Origin", "https://evil.example")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
		}
	})

	t.Run("bearer header wins over cookie and skips the origin check", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
		req.Header.Set("Authorization", "Bearer "+token)
		req.AddCookie(sessionCookie("garbage"))
		req.Header.Set("Origin", "https://evil.example")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}
	})

	t.Run("websocket handshake accepts the cookie", func(t *testing.T) {
		ws := gin.New()
		ws.Use(jwtMiddleware(testSecret, zap.NewNop(), 0, allowAllSessions{}, testOrigins))
		ws.GET("/ws", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
		req := httptest.NewRequest(http.MethodGet, "/ws", http.NoBody)
		req.AddCookie(sessionCookie(token))
		w := httptest.NewRecorder()
		ws.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
		}
	})
}

func TestJWTMiddleware_CookieRefreshSetsCookie(t *testing.T) {
	r := gin.New()
	r.Use(jwtMiddleware(testSecret, zap.NewNop(), time.Hour*24*365, allowAllSessions{}, testOrigins))
	r.GET("/api/test", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	claims := validClaims(42)
	claims["iat"] = time.Now().Add(-48 * time.Hour).Unix()
	claims["exp"] = time.Now().Add(time.Hour).Unix()
	token := createTestToken(t, claims, testSecret)

	req := httptest.NewRequest(http.MethodGet, "/api/test", http.NoBody)
	req.AddCookie(sessionCookie(token))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}
	if got := w.Header().Get("X-Refresh-Token"); got != "" {
		t.Fatalf("cookie clients must not get the token in a header, got %q", got)
	}
	var fresh *http.Cookie
	for _, ck := range w.Result().Cookies() {
		if ck.Name == authCookieName {
			fresh = ck
		}
	}
	if fresh == nil || fresh.Value == "" || fresh.Value == token {
		t.Fatalf("expected a rotated session cookie, got %+v", fresh)
	}
	if !fresh.HttpOnly || fresh.SameSite != http.SameSiteStrictMode || fresh.Path != "/" {
		t.Fatalf("cookie attributes wrong: %+v", fresh)
	}
}
