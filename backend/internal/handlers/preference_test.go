package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"messenger/internal/models"
	"messenger/internal/repositories"
	"messenger/internal/services"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

type memPrefStore struct {
	account map[uint]*models.UserPreference
	chats   map[[2]uint]*models.UserChatPreference
}

func newMemPrefStore() *memPrefStore {
	return &memPrefStore{
		account: make(map[uint]*models.UserPreference),
		chats:   make(map[[2]uint]*models.UserChatPreference),
	}
}

func (m *memPrefStore) GetAccountPref(_ context.Context, userID uint) (*models.UserPreference, error) {
	row, ok := m.account[userID]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	cp := *row
	return &cp, nil
}

func (m *memPrefStore) UpsertAccountPrefCAS(
	_ context.Context,
	next *models.UserPreference,
	expectedVersion int64,
) (*models.UserPreference, error) {
	cur, ok := m.account[next.UserID]
	if !ok {
		if expectedVersion != 0 {
			return models.DefaultUserPreference(next.UserID), repositories.ErrPreferenceVersionConflict
		}
		cp := *next
		cp.Version = 1
		m.account[next.UserID] = &cp
		out := cp
		return &out, nil
	}
	if next.LastIdempotencyKey != "" && cur.LastIdempotencyKey == next.LastIdempotencyKey {
		out := *cur
		return &out, nil
	}
	if cur.Version != expectedVersion {
		out := *cur
		return &out, repositories.ErrPreferenceVersionConflict
	}
	cp := *next
	cp.Version = cur.Version + 1
	m.account[next.UserID] = &cp
	out := cp
	return &out, nil
}

func (m *memPrefStore) GetChatPref(_ context.Context, userID, chatID uint) (*models.UserChatPreference, error) {
	row, ok := m.chats[[2]uint{userID, chatID}]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	cp := *row
	return &cp, nil
}

func (m *memPrefStore) ListChatPrefs(_ context.Context, userID uint) ([]models.UserChatPreference, error) {
	var out []models.UserChatPreference
	for k, v := range m.chats {
		if k[0] == userID {
			out = append(out, *v)
		}
	}
	return out, nil
}

func (m *memPrefStore) UpsertChatPrefCAS(
	_ context.Context,
	userID, chatID uint,
	expectedVersion int64,
	idempotencyKey string,
	mutate func(current *models.UserChatPreference),
) (*models.UserChatPreference, error) {
	key := [2]uint{userID, chatID}
	cur, ok := m.chats[key]
	var working models.UserChatPreference
	if !ok {
		working = *models.DefaultUserChatPreference(userID, chatID)
	} else {
		working = *cur
		if idempotencyKey != "" && working.LastIdempotencyKey == idempotencyKey {
			out := working
			return &out, nil
		}
	}
	if expectedVersion >= 0 && working.Version != expectedVersion {
		out := working
		return &out, repositories.ErrPreferenceVersionConflict
	}
	mutate(&working)
	working.UserID = userID
	working.ChatID = chatID
	working.Version++
	if idempotencyKey != "" {
		working.LastIdempotencyKey = idempotencyKey
	}
	m.chats[key] = &working
	out := working
	return &out, nil
}

type memChatLookup struct {
	chats map[uint]*models.Chat
}

func (m *memChatLookup) FindByIDLight(_ context.Context, id uint) (*models.Chat, error) {
	c, ok := m.chats[id]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	return c, nil
}

type memParticipantLookup struct{}

func (memParticipantLookup) FindByUserAndChat(_ context.Context, _, _ uint) (*models.ChatParticipant, error) {
	return nil, gorm.ErrRecordNotFound
}

func setupPreferenceTestRouter(userID uint) (*gin.Engine, *[]map[string]any) {
	gin.SetMode(gin.TestMode)
	u1, u2 := uint(1), uint(2)
	store := newMemPrefStore()
	chatLookup := &memChatLookup{
		chats: map[uint]*models.Chat{
			42: {Model: gorm.Model{ID: 42}, User1ID: &u1, User2ID: &u2},
		},
	}
	svc := services.NewPreferenceService(zap.NewNop(), store, chatLookup, memParticipantLookup{})
	h := newPreferenceHandler(svc)

	var events []map[string]any
	h.setOnPreferenceEventCallback(func(uid uint, payload map[string]any) {
		payload["_notified_user_id"] = uid
		events = append(events, payload)
	})

	r := gin.New()
	api := r.Group("/api")
	api.Use(func(c *gin.Context) {
		c.Set("user_id", userID)
		c.Next()
	})
	registerPreferenceRoutes(api, h)
	return r, &events
}

func performJSONRequest(r http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestPreferenceHandlers_EndToEndContractAndBroadcast(t *testing.T) {
	router, events := setupPreferenceTestRouter(1)

	// 1. Initial GET /api/preferences returns defaults
	w := performJSONRequest(router, http.MethodGet, "/api/preferences", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("GET /api/preferences = %d, want 200", w.Code)
	}

	// 2. PUT /api/preferences/account updates account prefs and emits WS event
	w = performJSONRequest(router, http.MethodPut, "/api/preferences/account", map[string]any{
		"theme":      map[string]any{"mode": "preset", "id": "classic-blue"},
		"appearance": "light",
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT /api/preferences/account = %d: %s", w.Code, w.Body.String())
	}
	if len(*events) != 1 || (*events)[0]["action"] != "prefs_updated" || (*events)[0]["scope"] != "account" {
		t.Fatalf("expected account prefs_updated WS event, got %+v", *events)
	}

	// 3. Stale expected_version returns 409 Conflict with code="version_conflict"
	w = performJSONRequest(router, http.MethodPut, "/api/preferences/account", map[string]any{
		"theme":            map[string]any{"mode": "preset", "id": "ocean"},
		"expected_version": 0,
	})
	if w.Code != http.StatusConflict {
		t.Fatalf("stale PUT /api/preferences/account = %d, want 409", w.Code)
	}
	var conflictBody map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &conflictBody)
	if conflictBody["code"] != codeVersionConflict || conflictBody["current"] == nil {
		t.Fatalf("expected code=%s and current state, got %+v", codeVersionConflict, conflictBody)
	}

	// 4. PUT /api/preferences/chats/42 sets per-chat override and emits WS event
	w = performJSONRequest(router, http.MethodPut, "/api/preferences/chats/42", map[string]any{
		"wallpaper": map[string]any{"mode": "none"},
		"sound":     map[string]any{"mode": "none"},
	})
	if w.Code != http.StatusOK {
		t.Fatalf("PUT /api/preferences/chats/42 = %d: %s", w.Code, w.Body.String())
	}

	// 5. DELETE /api/preferences/chats/42?fields=wallpaper resets wallpaper override to inherit
	w = performJSONRequest(router, http.MethodDelete, "/api/preferences/chats/42?fields=wallpaper", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("DELETE /api/preferences/chats/42 = %d: %s", w.Code, w.Body.String())
	}

	// 6. Unauthorized user (user 3) attempting to access chat 42 gets 403 Forbidden
	routerUser3, _ := setupPreferenceTestRouter(3)
	w = performJSONRequest(routerUser3, http.MethodPut, "/api/preferences/chats/42", map[string]any{
		"theme": map[string]any{"mode": "preset", "id": "forest"},
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("non-member PUT /api/preferences/chats/42 = %d, want 403", w.Code)
	}
}
