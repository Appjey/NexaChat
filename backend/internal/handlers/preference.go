package handlers

import (
	"errors"
	"net/http"
	"strings"

	"messenger/internal/repositories"
	"messenger/internal/services"

	"github.com/gin-gonic/gin"
)

type preferenceHandler struct {
	prefService       *services.PreferenceService
	onPreferenceEvent func(userID uint, payload map[string]any)
}

func newPreferenceHandler(prefService *services.PreferenceService) *preferenceHandler {
	return &preferenceHandler{prefService: prefService}
}

func (h *preferenceHandler) setOnPreferenceEventCallback(cb func(userID uint, payload map[string]any)) {
	h.onPreferenceEvent = cb
}

func (h *preferenceHandler) notifyUserDevices(userID uint, payload map[string]any) {
	if h.onPreferenceEvent != nil {
		h.onPreferenceEvent(userID, payload)
	}
}

func (h *preferenceHandler) GetAllPreferencesAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	out, err := h.prefService.GetAllPreferences(c.Request.Context(), userID)
	if err != nil {
		sendInternalError(c, "Failed to load preferences")
		return
	}
	sendSuccess(c, out)
}

func (h *preferenceHandler) UpdateAccountPreferencesAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	var in services.AccountPreferenceInput
	if err := c.ShouldBindJSON(&in); err != nil {
		sendError(c, http.StatusBadRequest, codeValidation, "Invalid request body")
		return
	}

	updated, err := h.prefService.UpdateAccountPreferences(c.Request.Context(), userID, in)
	if err != nil {
		if errors.Is(err, repositories.ErrPreferenceVersionConflict) {
			c.JSON(http.StatusConflict, gin.H{
				"error":   "Preferences were modified on another device",
				"code":    codeVersionConflict,
				"current": updated,
			})
			return
		}
		if errors.Is(err, services.ErrPreferenceValidation) {
			sendError(c, http.StatusBadRequest, codeValidation, err.Error())
			return
		}
		sendInternalError(c, "Failed to update account preferences")
		return
	}

	h.notifyUserDevices(userID, map[string]any{
		"action":  "prefs_updated",
		"scope":   "account",
		"user_id": userID,
		"account": updated,
	})
	sendSuccess(c, gin.H{"account": updated})
}

func (h *preferenceHandler) GetChatPreferenceAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}
	chatID, err := parseUintParam(c, "chat_id")
	if err != nil || chatID == 0 {
		sendBadRequest(c, "Invalid chat ID")
		return
	}

	pref, eff, err := h.prefService.GetChatPreferenceWithEffective(c.Request.Context(), userID, chatID)
	if err != nil {
		handlePreferenceServiceError(c, err, nil)
		return
	}
	sendSuccess(c, gin.H{
		"preference": pref,
		"effective":  eff,
	})
}

func (h *preferenceHandler) UpdateChatPreferenceAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}
	chatID, err := parseUintParam(c, "chat_id")
	if err != nil || chatID == 0 {
		sendBadRequest(c, "Invalid chat ID")
		return
	}

	var in services.ChatPreferenceInput
	if err := c.ShouldBindJSON(&in); err != nil {
		sendError(c, http.StatusBadRequest, codeValidation, "Invalid request body")
		return
	}

	pref, eff, err := h.prefService.UpdateChatPreference(c.Request.Context(), userID, chatID, in)
	if err != nil {
		handlePreferenceServiceError(c, err, pref)
		return
	}

	h.notifyUserDevices(userID, map[string]any{
		"action":     "prefs_updated",
		"scope":      "chat",
		"user_id":    userID,
		"chat_id":    chatID,
		"preference": pref,
		"effective":  eff,
	})
	sendSuccess(c, gin.H{
		"preference": pref,
		"effective":  eff,
	})
}

func (h *preferenceHandler) ResetChatPreferenceAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}
	chatID, err := parseUintParam(c, "chat_id")
	if err != nil || chatID == 0 {
		sendBadRequest(c, "Invalid chat ID")
		return
	}

	var fields []string
	if rawFields := strings.TrimSpace(c.Query("fields")); rawFields != "" {
		for _, part := range strings.Split(rawFields, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				fields = append(fields, trimmed)
			}
		}
	}

	pref, eff, err := h.prefService.ResetChatPreference(c.Request.Context(), userID, chatID, fields)
	if err != nil {
		handlePreferenceServiceError(c, err, pref)
		return
	}

	h.notifyUserDevices(userID, map[string]any{
		"action":     "prefs_updated",
		"scope":      "chat",
		"user_id":    userID,
		"chat_id":    chatID,
		"preference": pref,
		"effective":  eff,
	})
	sendSuccess(c, gin.H{
		"preference": pref,
		"effective":  eff,
	})
}

func (h *preferenceHandler) BulkApplyPreferencesAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}

	var in services.BulkApplyInput
	if err := c.ShouldBindJSON(&in); err != nil {
		sendError(c, http.StatusBadRequest, codeValidation, "Invalid request body")
		return
	}

	out, err := h.prefService.BulkApplyPreferences(c.Request.Context(), userID, in)
	if err != nil {
		handlePreferenceServiceError(c, err, nil)
		return
	}

	h.notifyUserDevices(userID, map[string]any{
		"action":  "prefs_updated",
		"scope":   "bulk",
		"user_id": userID,
		"result":  out,
	})
	sendSuccess(c, out)
}

func handlePreferenceServiceError(c *gin.Context, err error, current any) {
	switch {
	case errors.Is(err, services.ErrChatNotFound):
		sendNotFound(c, "Chat not found")
	case errors.Is(err, services.ErrChatAccessDenied):
		sendForbidden(c, "Access denied")
	case errors.Is(err, repositories.ErrPreferenceVersionConflict):
		c.JSON(http.StatusConflict, gin.H{
			"error":   "Preferences were modified on another device",
			"code":    codeVersionConflict,
			"current": current,
		})
	case errors.Is(err, services.ErrPreferenceValidation):
		sendError(c, http.StatusBadRequest, codeValidation, err.Error())
	default:
		sendInternalError(c, "Preference operation failed")
	}
}
