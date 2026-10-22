package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// clientErrorHandler receives error reports from the frontend (shared/log.ts →
// shared/errorReporting.ts) and writes them to the server log. There is no
// storage and no dashboard: the goal is that a failure on a user's device is
// visible in `docker compose logs backend` next to the request logs, with the
// user id, instead of vanishing in a WebView nobody inspects.
type clientErrorHandler struct {
	logger *zap.Logger
}

func newClientErrorHandler(logger *zap.Logger) *clientErrorHandler {
	return &clientErrorHandler{logger: logger}
}

// clientErrorReport is the wire format. Every field is capped so a buggy or
// hostile client cannot write megabytes into the log per request (the global
// 1 MiB JSON body limit is the outer bound).
type clientErrorReport struct {
	Message   string `json:"message" binding:"required,max=2000"`
	Stack     string `json:"stack" binding:"max=8000"`
	Context   string `json:"context" binding:"max=500"`
	URL       string `json:"url" binding:"max=500"`
	Platform  string `json:"platform" binding:"max=32"`
	UserAgent string `json:"user_agent" binding:"max=300"`
}

// Report handles POST /api/client-errors (JWT required). Always answers 204 on
// a well-formed body: the client fires and forgets.
func (h *clientErrorHandler) Report(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}
	var req clientErrorReport
	if err := c.ShouldBindJSON(&req); err != nil {
		sendBadRequest(c, "Invalid report")
		return
	}
	h.logger.Warn("client error",
		zap.Uint("user_id", userID),
		zap.String("platform", req.Platform),
		zap.String("message", req.Message),
		zap.String("context", req.Context),
		zap.String("url", req.URL),
		zap.String("user_agent", req.UserAgent),
		zap.String("stack", req.Stack),
	)
	c.Status(http.StatusNoContent)
}
