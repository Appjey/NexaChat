package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// authCookieName carries the JWT for browser clients. The web app never sees
// the token: the cookie is HttpOnly, so an XSS cannot read it, and SameSite
// Strict keeps other sites from riding on it. Native shells (Capacitor,
// Electron) keep using the Authorization header — their requests to the API
// are cross-site from the https://localhost origin, so a Strict cookie would
// never be sent for them anyway.
const authCookieName = "auth_token"

// Where the token on a request came from. Stored in the gin context as
// authSourceKey so the sliding refresh can hand the new token back the same
// way it arrived.
const (
	authSourceKey    = "auth_source"
	authSourceBearer = "bearer"
	authSourceCookie = "cookie"
	authSourceQuery  = "query"
)

// requestIsHTTPS reports whether the client reached us over TLS, directly or
// through the reverse proxy (X-Forwarded-Proto is only trusted from the
// configured proxies, see config.TrustedProxies). Decides the cookie's Secure
// flag: a Secure cookie over plain http://localhost (dev) would be dropped by
// some browsers, while in production the cookie must never travel over http.
func requestIsHTTPS(c *gin.Context) bool {
	if c.Request.TLS != nil {
		return true
	}
	return strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
}

// setAuthCookie installs the session cookie for the lifetime of the token.
func setAuthCookie(c *gin.Context, token string, ttl time.Duration) {
	http.SetCookie(c.Writer, &http.Cookie{ //nolint:gosec // G124: Secure is requestIsHTTPS(c) — true in production, off only for plain-http dev
		Name:     authCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   requestIsHTTPS(c),
		SameSite: http.SameSiteStrictMode,
	})
}

// clearAuthCookie expires the session cookie (logout).
func clearAuthCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{ //nolint:gosec // G124: same attributes as setAuthCookie, expiring the cookie
		Name:     authCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   requestIsHTTPS(c),
		SameSite: http.SameSiteStrictMode,
	})
}

// authCookieToken returns the token from the session cookie, or "".
func authCookieToken(c *gin.Context) string {
	cookie, err := c.Request.Cookie(authCookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}
