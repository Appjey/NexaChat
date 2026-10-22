package handlers

import (
	"io"
	"path/filepath"
	"strings"

	"messenger/internal/storage"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// contentTypesByExtension maps file extensions to MIME types.
// Package-level for efficiency (avoid recreating on each call).
var contentTypesByExtension = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".gif":  "image/gif",
	".webp": "image/webp",
	".svg":  "image/svg+xml",
	".pdf":  "application/pdf",
	".doc":  "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls":  "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt":  "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".txt":  "text/plain",
	".mp4":  "video/mp4",
	".mov":  "video/quicktime",
	".avi":  "video/x-msvideo",
	".mp3":  "audio/mpeg",
	".wav":  "audio/wav",
	".zip":  "application/zip",
	".rar":  "application/x-rar-compressed",
}

// fileHandler handles file serving with authorization
type fileHandler struct {
	storage storage.Storage
	logger  *zap.Logger
}

// newFileHandler creates a new file handler
func newFileHandler(fileStorage storage.Storage, logger *zap.Logger) *fileHandler {
	return &fileHandler{
		storage: fileStorage,
		logger:  logger,
	}
}

// ServeFile serves a file with authorization check
func (h *fileHandler) ServeFile(c *gin.Context) {
	_, ok := requireUserID(c)
	if !ok {
		return
	}

	filename := c.Param("filename")
	if filename == "" {
		sendBadRequest(c, "Filename is required")
		return
	}

	// Validate filename to prevent path traversal attacks
	if err := validateFilename(filename); err != nil {
		h.logger.Warn("invalid filename attempted",
			zap.String("filename", filename),
			zap.Error(err),
		)
		sendBadRequest(c, "Invalid filename")
		return
	}

	// Get file from storage
	reader, err := h.storage.Get(filename)
	if err != nil {
		h.logger.Error("failed to get file from storage",
			zap.String("filename", filename),
			zap.Error(err),
		)
		sendNotFound(c, "File not found")
		return
	}
	defer func() { _ = reader.Close() }()

	// Detect content type from file extension
	ext := strings.ToLower(filepath.Ext(filename))
	contentType := getContentTypeFromExtension(ext)

	// Set headers
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", "inline; filename=\""+filepath.Base(filename)+"\"")

	// Stream file to client
	if _, err := io.Copy(c.Writer, reader); err != nil {
		h.logger.Error("failed to send file",
			zap.String("filename", filename),
			zap.Error(err),
		)
		return
	}
}

// validateFilename checks for path traversal attempts
func validateFilename(filename string) error {
	// Reject any directory separators — only bare filenames are allowed.
	if strings.Contains(filename, "/") {
		return &wsError{message: "subdirectory paths not allowed"}
	}
	if strings.Contains(filename, "\\") {
		return &wsError{message: "backslashes not allowed"}
	}
	// Check for path traversal patterns
	if strings.Contains(filename, "..") {
		return &wsError{message: "path traversal not allowed"}
	}
	if filepath.IsAbs(filename) {
		return &wsError{message: "absolute paths not allowed"}
	}

	// Clean the path — catches any remaining OS-specific tricks.
	cleaned := filepath.Clean(filename)
	if cleaned != filename {
		return &wsError{message: "filename contains invalid characters"}
	}

	return nil
}

// getContentTypeFromExtension returns MIME type for file extension
func getContentTypeFromExtension(ext string) string {
	if contentType, ok := contentTypesByExtension[ext]; ok {
		return contentType
	}
	return "application/octet-stream"
}
