package services

import (
	"context"
	"errors"
	"testing"

	"messenger/internal/models"
	"messenger/internal/repositories"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

type fakePreferenceStore struct {
	accountPrefs map[uint]*models.UserPreference
	chatPrefs    map[[2]uint]*models.UserChatPreference
}

func newFakePreferenceStore() *fakePreferenceStore {
	return &fakePreferenceStore{
		accountPrefs: make(map[uint]*models.UserPreference),
		chatPrefs:    make(map[[2]uint]*models.UserChatPreference),
	}
}

func (f *fakePreferenceStore) GetAccountPref(_ context.Context, userID uint) (*models.UserPreference, error) {
	row, ok := f.accountPrefs[userID]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	cp := *row
	return &cp, nil
}

func (f *fakePreferenceStore) UpsertAccountPrefCAS(
	_ context.Context,
	next *models.UserPreference,
	expectedVersion int64,
) (*models.UserPreference, error) {
	cur, exists := f.accountPrefs[next.UserID]
	if !exists {
		if expectedVersion != 0 {
			return models.DefaultUserPreference(next.UserID), repositories.ErrPreferenceVersionConflict
		}
		cp := *next
		cp.Version = 1
		f.accountPrefs[next.UserID] = &cp
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
	f.accountPrefs[next.UserID] = &cp
	out := cp
	return &out, nil
}

func (f *fakePreferenceStore) GetChatPref(_ context.Context, userID, chatID uint) (*models.UserChatPreference, error) {
	row, ok := f.chatPrefs[[2]uint{userID, chatID}]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	cp := *row
	return &cp, nil
}

func (f *fakePreferenceStore) ListChatPrefs(_ context.Context, userID uint) ([]models.UserChatPreference, error) {
	var list []models.UserChatPreference
	for key, row := range f.chatPrefs {
		if key[0] == userID {
			list = append(list, *row)
		}
	}
	return list, nil
}

func (f *fakePreferenceStore) UpsertChatPrefCAS(
	_ context.Context,
	userID, chatID uint,
	expectedVersion int64,
	idempotencyKey string,
	mutate func(current *models.UserChatPreference),
) (*models.UserChatPreference, error) {
	key := [2]uint{userID, chatID}
	cur, exists := f.chatPrefs[key]
	var working models.UserChatPreference
	if !exists {
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
	f.chatPrefs[key] = &working
	out := working
	return &out, nil
}

type fakeChatLookup struct {
	chats map[uint]*models.Chat
}

func (f *fakeChatLookup) FindByIDLight(_ context.Context, id uint) (*models.Chat, error) {
	c, ok := f.chats[id]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	return c, nil
}

type fakeParticipantLookup struct {
	members map[[2]uint]*models.ChatParticipant
}

func (f *fakeParticipantLookup) FindByUserAndChat(_ context.Context, chatID, userID uint) (*models.ChatParticipant, error) {
	p, ok := f.members[[2]uint{chatID, userID}]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	return p, nil
}

func newTestPreferenceEnv() (*PreferenceService, *fakePreferenceStore) {
	u1, u2 := uint(1), uint(2)
	store := newFakePreferenceStore()
	chats := &fakeChatLookup{
		chats: map[uint]*models.Chat{
			10: {Model: gorm.Model{ID: 10}, User1ID: &u1, User2ID: &u2, IsGroup: false},
			20: {Model: gorm.Model{ID: 20}, IsGroup: true},
		},
	}
	participants := &fakeParticipantLookup{
		members: map[[2]uint]*models.ChatParticipant{
			{20, 1}: {ChatID: 20, UserID: 1, Role: models.RoleCreator},
			{20, 2}: {ChatID: 20, UserID: 2, Role: models.RoleMember},
		},
	}
	svc := NewPreferenceService(zap.NewNop(), store, chats, participants)
	return svc, store
}

func TestResolveEffectiveChatPreference_PriorityHierarchy(t *testing.T) {
	// 1. Built-in default when account and chatPref are nil
	effDefault := ResolveEffectiveChatPreference(10, nil, nil, nil)
	if effDefault.Theme.ID != "nexachat" || effDefault.Theme.Source != SourceBuiltInDefault {
		t.Fatalf("expected built-in default theme, got %+v", effDefault.Theme)
	}
	if effDefault.Wallpaper.Mode != models.PrefModeNone || effDefault.Wallpaper.Source != SourceBuiltInDefault {
		t.Fatalf("expected built-in none wallpaper, got %+v", effDefault.Wallpaper)
	}
	if effDefault.Sound.ID != "nexa" || effDefault.Sound.Source != SourceBuiltInDefault {
		t.Fatalf("expected built-in nexa sound, got %+v", effDefault.Sound)
	}

	// 2. Account global overrides built-in default
	acc := models.DefaultUserPreference(1)
	acc.ThemeMode = models.PrefModePreset
	acc.ThemeID = "ocean"
	acc.Appearance = models.AppearanceLight
	acc.WallpaperMode = models.PrefModePreset
	acc.WallpaperID = "grad-aurora"
	acc.SoundMode = models.PrefModePreset
	acc.SoundID = "bell"

	effGlobal := ResolveEffectiveChatPreference(10, acc, nil, nil)
	if effGlobal.Theme.ID != "ocean" || effGlobal.Theme.Source != SourceAccountGlobal {
		t.Fatalf("expected account global theme ocean, got %+v", effGlobal.Theme)
	}
	if effGlobal.Wallpaper.ID != "grad-aurora" || effGlobal.Wallpaper.Source != SourceAccountGlobal {
		t.Fatalf("expected account global wallpaper grad-aurora, got %+v", effGlobal.Wallpaper)
	}
	if effGlobal.Sound.ID != "bell" || effGlobal.Sound.Source != SourceAccountGlobal {
		t.Fatalf("expected account global sound bell, got %+v", effGlobal.Sound)
	}

	// 3. Accepted shared chat value overrides account global, while personal override overrides shared!
	chatPref := models.DefaultUserChatPreference(1, 10)
	chatPref.SharedThemeMode = models.PrefModePreset
	chatPref.SharedThemeID = "lavender"
	chatPref.SharedWallpaperMode = models.PrefModePreset
	chatPref.SharedWallpaperID = "pat-dots"
	// Personal override on wallpaper ONLY -> theme should come from shared ("lavender"),
	// wallpaper from personal ("solid-midnight"), sound from global ("bell").
	chatPref.WallpaperMode = models.PrefModePreset
	chatPref.WallpaperID = "solid-midnight"

	effMixed := ResolveEffectiveChatPreference(10, acc, chatPref, nil)
	if effMixed.Theme.ID != "lavender" || effMixed.Theme.Source != SourceAcceptedShared {
		t.Fatalf("expected accepted shared theme lavender, got %+v", effMixed.Theme)
	}
	if effMixed.Wallpaper.ID != "solid-midnight" || effMixed.Wallpaper.Source != SourcePersonalOverride {
		t.Fatalf("expected personal override wallpaper solid-midnight, got %+v", effMixed.Wallpaper)
	}
	if effMixed.Sound.ID != "bell" || effMixed.Sound.Source != SourceAccountGlobal {
		t.Fatalf("expected global sound bell to remain inherited, got %+v", effMixed.Sound)
	}
}

func TestPreferenceService_ExplicitNoneVsInheritAndReset(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestPreferenceEnv()

	// Set account global wallpaper and sound to presets
	_, err := svc.UpdateAccountPreferences(ctx, 1, AccountPreferenceInput{
		Wallpaper: &FieldPatch{Mode: models.PrefModePreset, ID: "grad-ocean"},
		Sound:     &FieldPatch{Mode: models.PrefModePreset, ID: "pulse"},
	})
	if err != nil {
		t.Fatalf("UpdateAccountPreferences: %v", err)
	}

	// Set chat 10 wallpaper to explicit "none" ("Без фона") and sound to explicit "none" ("Без звука")
	_, eff, err := svc.UpdateChatPreference(ctx, 1, 10, ChatPreferenceInput{
		Wallpaper: &FieldPatch{Mode: models.PrefModeNone},
		Sound:     &FieldPatch{Mode: models.PrefModeNone},
	})
	if err != nil {
		t.Fatalf("UpdateChatPreference explicit none: %v", err)
	}
	if eff.Wallpaper.Mode != models.PrefModeNone || eff.Wallpaper.Source != SourcePersonalOverride {
		t.Fatalf("explicit none wallpaper must stop inheritance, got %+v", eff.Wallpaper)
	}
	if eff.Sound.Mode != models.PrefModeNone || eff.Sound.Source != SourcePersonalOverride {
		t.Fatalf("explicit none sound must stop inheritance, got %+v", eff.Sound)
	}

	// Reset only wallpaper back to inherit -> wallpaper inherits "grad-ocean", sound stays "none"
	_, effAfterPartialReset, err := svc.ResetChatPreference(ctx, 1, 10, []string{"wallpaper"})
	if err != nil {
		t.Fatalf("ResetChatPreference(wallpaper): %v", err)
	}
	if effAfterPartialReset.Wallpaper.ID != "grad-ocean" || effAfterPartialReset.Wallpaper.Source != SourceAccountGlobal {
		t.Fatalf("reset wallpaper should inherit grad-ocean from account, got %+v", effAfterPartialReset.Wallpaper)
	}
	if effAfterPartialReset.Sound.Mode != models.PrefModeNone || effAfterPartialReset.Sound.Source != SourcePersonalOverride {
		t.Fatalf("sound override should remain untouched after wallpaper reset, got %+v", effAfterPartialReset.Sound)
	}

	// Full reset returns all fields to inherit
	_, effFullReset, err := svc.ResetChatPreference(ctx, 1, 10, nil)
	if err != nil {
		t.Fatalf("ResetChatPreference(all): %v", err)
	}
	if effFullReset.Sound.ID != "pulse" || effFullReset.Sound.Source != SourceAccountGlobal {
		t.Fatalf("full reset should restore sound inheritance to pulse, got %+v", effFullReset.Sound)
	}
}

func TestPreferenceService_CASConflictAndIdempotency(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestPreferenceEnv()

	v0 := int64(0)
	acc1, err := svc.UpdateAccountPreferences(ctx, 1, AccountPreferenceInput{
		Theme:           &FieldPatch{Mode: models.PrefModePreset, ID: "forest"},
		ExpectedVersion: &v0,
		IdempotencyKey:  "req-1",
	})
	if err != nil {
		t.Fatalf("initial update: %v", err)
	}
	if acc1.Version != 1 {
		t.Fatalf("expected version 1, got %d", acc1.Version)
	}

	// Retrying with the same idempotency key and old expected_version=0 must succeed idempotently
	retryAcc, err := svc.UpdateAccountPreferences(ctx, 1, AccountPreferenceInput{
		Theme:           &FieldPatch{Mode: models.PrefModePreset, ID: "forest"},
		ExpectedVersion: &v0,
		IdempotencyKey:  "req-1",
	})
	if err != nil {
		t.Fatalf("idempotent retry failed: %v", err)
	}
	if retryAcc.Version != 1 {
		t.Fatalf("idempotent retry should not bump version, got %d", retryAcc.Version)
	}

	// Another device updates with a different key and stale expected_version=0 -> CAS conflict!
	currentOnConflict, err := svc.UpdateAccountPreferences(ctx, 1, AccountPreferenceInput{
		Theme:           &FieldPatch{Mode: models.PrefModePreset, ID: "graphite"},
		ExpectedVersion: &v0,
		IdempotencyKey:  "req-2-stale",
	})
	if !errors.Is(err, repositories.ErrPreferenceVersionConflict) {
		t.Fatalf("expected ErrPreferenceVersionConflict, got %v", err)
	}
	if currentOnConflict == nil || currentOnConflict.ThemeID != "forest" || currentOnConflict.Version != 1 {
		t.Fatalf("conflict must return current server state, got %+v", currentOnConflict)
	}
}

func TestPreferenceService_AccessControlAndUserIsolation(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestPreferenceEnv()

	// User 3 is not a member of 1-on-1 chat 10 or group chat 20
	_, _, err := svc.UpdateChatPreference(ctx, 3, 10, ChatPreferenceInput{
		Theme: &FieldPatch{Mode: models.PrefModePreset, ID: "ocean"},
	})
	if !errors.Is(err, ErrChatAccessDenied) {
		t.Fatalf("expected ErrChatAccessDenied for non-member on 1-on-1 chat, got %v", err)
	}

	_, _, err = svc.GetChatPreferenceWithEffective(ctx, 3, 20)
	if !errors.Is(err, ErrChatAccessDenied) {
		t.Fatalf("expected ErrChatAccessDenied for non-member on group chat, got %v", err)
	}

	// User 1 sets override on chat 10; User 2's preferences for chat 10 remain default/inherit
	_, _, err = svc.UpdateChatPreference(ctx, 1, 10, ChatPreferenceInput{
		Theme: &FieldPatch{Mode: models.PrefModePreset, ID: "lavender"},
	})
	if err != nil {
		t.Fatalf("User 1 UpdateChatPreference: %v", err)
	}

	u2Pref, u2Eff, err := svc.GetChatPreferenceWithEffective(ctx, 2, 10)
	if err != nil {
		t.Fatalf("User 2 GetChatPreferenceWithEffective: %v", err)
	}
	if u2Pref.ThemeMode != models.PrefModeInherit || u2Eff.Theme.ID != "nexachat" {
		t.Fatalf("User 1 must not affect User 2 personal chat prefs, got pref=%+v eff=%+v", u2Pref, u2Eff)
	}
}

func TestPreferenceService_BulkApply_AllPreservesOverridesAndSelectedReportsPartialErrors(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestPreferenceEnv()

	// User 1 creates an explicit override on chat 10
	_, _, err := svc.UpdateChatPreference(ctx, 1, 10, ChatPreferenceInput{
		Theme: &FieldPatch{Mode: models.PrefModePreset, ID: "lavender"},
	})
	if err != nil {
		t.Fatalf("UpdateChatPreference: %v", err)
	}

	// Bulk apply to "all" chats changes global theme to "forest", preserving chat 10's "lavender" override
	bulkAllOut, err := svc.BulkApplyPreferences(ctx, 1, BulkApplyInput{
		Scope:      "all",
		Visibility: "personal",
		Theme:      &FieldPatch{Mode: models.PrefModePreset, ID: "forest"},
	})
	if err != nil {
		t.Fatalf("BulkApplyPreferences(all): %v", err)
	}
	if bulkAllOut.Account == nil || bulkAllOut.Account.ThemeID != "forest" {
		t.Fatalf("expected account theme forest, got %+v", bulkAllOut.Account)
	}
	_, eff10, _ := svc.GetChatPreferenceWithEffective(ctx, 1, 10)
	if eff10.Theme.ID != "lavender" || eff10.Theme.Source != SourcePersonalOverride {
		t.Fatalf("global bulk apply must preserve chat 10 override, got %+v", eff10.Theme)
	}
	_, eff20, _ := svc.GetChatPreferenceWithEffective(ctx, 1, 20)
	if eff20.Theme.ID != "forest" || eff20.Theme.Source != SourceAccountGlobal {
		t.Fatalf("chat 20 without override should inherit new global theme forest, got %+v", eff20.Theme)
	}

	// Bulk apply to "selected" chats with valid (10, 20) and non-existent (999) chat IDs
	bulkSelOut, err := svc.BulkApplyPreferences(ctx, 1, BulkApplyInput{
		Scope:      "selected",
		Visibility: "personal",
		ChatIDs:    []uint{10, 20, 999},
		Wallpaper:  &FieldPatch{Mode: models.PrefModePreset, ID: "pat-waves"},
	})
	if err != nil {
		t.Fatalf("BulkApplyPreferences(selected): %v", err)
	}
	if bulkSelOut.Total != 3 || bulkSelOut.AppliedCount != 2 || bulkSelOut.FailedCount != 1 {
		t.Fatalf("expected total=3 applied=2 failed=1, got %+v", bulkSelOut)
	}
	if bulkSelOut.Results[2].Status != "error" || bulkSelOut.Results[2].Code != "not_found" {
		t.Fatalf("expected chat 999 to report not_found error, got %+v", bulkSelOut.Results[2])
	}
}

func TestPreferenceService_FallbackAndUnknownFieldsPreservation(t *testing.T) {
	ctx := context.Background()
	svc, _ := newTestPreferenceEnv()

	// Newer client saves unknown preset IDs and extra forward-compatible fields
	acc, err := svc.UpdateAccountPreferences(ctx, 1, AccountPreferenceInput{
		Theme:     &FieldPatch{Mode: models.PrefModePreset, ID: "future-holo-2029"},
		Wallpaper: &FieldPatch{Mode: models.PrefModePreset, ID: "future-nebula"},
		Sound:     &FieldPatch{Mode: models.PrefModePreset, ID: "future-chime"},
		ExtraFields: map[string]any{
			"future_blur_intensity": 0.85,
		},
	})
	if err != nil {
		t.Fatalf("UpdateAccountPreferences with future preset: %v", err)
	}
	if acc.ThemeID != "future-holo-2029" {
		t.Fatalf("stored theme_id must not be overwritten, got %s", acc.ThemeID)
	}

	// Subsequent update from an older client that doesn't send ExtraFields must preserve existing ExtraFields
	light := models.AppearanceLight
	acc2, err := svc.UpdateAccountPreferences(ctx, 1, AccountPreferenceInput{
		Appearance: &light,
	})
	if err != nil {
		t.Fatalf("second UpdateAccountPreferences: %v", err)
	}
	if acc2.ExtraFields["future_blur_intensity"] != 0.85 {
		t.Fatalf("expected extra_fields to be preserved across updates, got %+v", acc2.ExtraFields)
	}

	// Resolution falls back safely to LastKnownGood or built-in defaults without mutating stored data
	lkg := &LastKnownGoodPrefs{
		ThemeID:       "classic-blue",
		WallpaperMode: models.PrefModePreset,
		WallpaperID:   "solid-sage",
		SoundMode:     models.PrefModePreset,
		SoundID:       "soft",
	}
	effWithLKG := ResolveEffectiveChatPreference(10, &acc2.UserPreference, nil, lkg)
	if !effWithLKG.Theme.FallbackApplied || effWithLKG.Theme.ID != "classic-blue" {
		t.Fatalf("expected theme fallback to LKG classic-blue, got %+v", effWithLKG.Theme)
	}
	if !effWithLKG.Wallpaper.FallbackApplied || effWithLKG.Wallpaper.ID != "solid-sage" {
		t.Fatalf("expected wallpaper fallback to LKG solid-sage, got %+v", effWithLKG.Wallpaper)
	}
	if !effWithLKG.Sound.FallbackApplied || effWithLKG.Sound.ID != "soft" {
		t.Fatalf("expected sound fallback to LKG soft, got %+v", effWithLKG.Sound)
	}
}
