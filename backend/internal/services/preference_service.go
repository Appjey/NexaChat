package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"messenger/internal/models"
	"messenger/internal/repositories"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	// ErrPreferenceValidation indicates an invalid mode or missing required field.
	ErrPreferenceValidation = errors.New("invalid preference value")
	// ErrChatAccessDenied indicates the user is not a member of the target chat.
	ErrChatAccessDenied = errors.New("access denied")
	// ErrChatNotFound indicates the target chat does not exist.
	ErrChatNotFound = errors.New("chat not found")
)

// FieldPatch describes an update to a single preference dimension (theme, wallpaper, or sound).
type FieldPatch struct {
	Mode    models.PreferenceValueMode `json:"mode"`
	ID      string                     `json:"id"`
	Version *int                       `json:"version,omitempty"`
}

// AccountPreferenceInput carries a partial update to account-wide preferences.
type AccountPreferenceInput struct {
	Theme                *FieldPatch            `json:"theme,omitempty"`
	Appearance           *models.AppearanceMode `json:"appearance,omitempty"`
	Wallpaper            *FieldPatch            `json:"wallpaper,omitempty"`
	Sound                *FieldPatch            `json:"sound,omitempty"`
	NotificationsEnabled *bool                  `json:"notifications_enabled,omitempty"`
	ExpectedVersion      *int64                 `json:"expected_version,omitempty"`
	IdempotencyKey       string                 `json:"idempotency_key,omitempty"`
	ExtraFields          map[string]any         `json:"extra_fields,omitempty"`
}

// ChatPreferenceInput carries a partial update to per-user, per-chat preferences.
type ChatPreferenceInput struct {
	Theme            *FieldPatch            `json:"theme,omitempty"`
	Appearance       *models.AppearanceMode `json:"appearance,omitempty"`
	Wallpaper        *FieldPatch            `json:"wallpaper,omitempty"`
	Sound            *FieldPatch            `json:"sound,omitempty"`
	Muted            *bool                  `json:"muted,omitempty"`
	SharedTheme      *FieldPatch            `json:"shared_theme,omitempty"`
	SharedAppearance *models.AppearanceMode `json:"shared_appearance,omitempty"`
	SharedWallpaper  *FieldPatch            `json:"shared_wallpaper,omitempty"`
	SharedSound      *FieldPatch            `json:"shared_sound,omitempty"`
	ExpectedVersion  *int64                 `json:"expected_version,omitempty"`
	IdempotencyKey   string                 `json:"idempotency_key,omitempty"`
	ExtraFields      map[string]any         `json:"extra_fields,omitempty"`
}

// BulkApplyInput carries a bulk personalization request across "all" or "selected" chats.
type BulkApplyInput struct {
	Scope                  string                 `json:"scope"`
	Visibility             string                 `json:"visibility"`
	ChatIDs                []uint                 `json:"chat_ids,omitempty"`
	Theme                  *FieldPatch            `json:"theme,omitempty"`
	Appearance             *models.AppearanceMode `json:"appearance,omitempty"`
	Wallpaper              *FieldPatch            `json:"wallpaper,omitempty"`
	Sound                  *FieldPatch            `json:"sound,omitempty"`
	Muted                  *bool                  `json:"muted,omitempty"`
	ExpectedAccountVersion *int64                 `json:"expected_account_version,omitempty"`
	ChatExpectedVersions   map[uint]int64         `json:"chat_expected_versions,omitempty"`
	IdempotencyKey         string                 `json:"idempotency_key,omitempty"`
}

// AccountPreferenceDTO is the serialized representation of account preferences.
type AccountPreferenceDTO struct {
	models.UserPreference
	ExtraFields map[string]any `json:"extra_fields,omitempty"`
}

// ChatPreferenceDTO is the serialized representation of per-chat preferences.
type ChatPreferenceDTO struct {
	models.UserChatPreference
	ExtraFields map[string]any `json:"extra_fields,omitempty"`
}

// AllPreferencesOutput bundles account preferences and all per-chat overrides for a user.
type AllPreferencesOutput struct {
	Account       AccountPreferenceDTO `json:"account"`
	ChatOverrides []ChatPreferenceDTO  `json:"chat_overrides"`
}

// BulkApplyChatResult reports the per-chat outcome of a bulk apply operation.
type BulkApplyChatResult struct {
	ChatID     uint                     `json:"chat_id"`
	Status     string                   `json:"status"`
	Visibility string                   `json:"visibility,omitempty"`
	Code       string                   `json:"code,omitempty"`
	Error      string                   `json:"error,omitempty"`
	Preference *ChatPreferenceDTO       `json:"preference,omitempty"`
	Effective  *EffectiveChatPreference `json:"effective,omitempty"`
}

// BulkApplyOutput summarizes the outcome of a bulk apply operation.
type BulkApplyOutput struct {
	Scope        string                `json:"scope"`
	Visibility   string                `json:"visibility"`
	Total        int                   `json:"total"`
	AppliedCount int                   `json:"applied_count"`
	FailedCount  int                   `json:"failed_count"`
	Account      *AccountPreferenceDTO `json:"account,omitempty"`
	Results      []BulkApplyChatResult `json:"results"`
}

// preferenceStore abstracts persistence for account and per-chat preferences.
type preferenceStore interface {
	GetAccountPref(ctx context.Context, userID uint) (*models.UserPreference, error)
	UpsertAccountPrefCAS(ctx context.Context, next *models.UserPreference, expectedVersion int64) (*models.UserPreference, error)
	GetChatPref(ctx context.Context, userID, chatID uint) (*models.UserChatPreference, error)
	ListChatPrefs(ctx context.Context, userID uint) ([]models.UserChatPreference, error)
	UpsertChatPrefCAS(
		ctx context.Context,
		userID, chatID uint,
		expectedVersion int64,
		idempotencyKey string,
		mutate func(current *models.UserChatPreference),
	) (*models.UserChatPreference, error)
}

type chatLookupStore interface {
	FindByIDLight(ctx context.Context, id uint) (*models.Chat, error)
}

type participantLookupStore interface {
	FindByUserAndChat(ctx context.Context, chatID, userID uint) (*models.ChatParticipant, error)
}

// PreferenceService coordinates personalization storage, validation, resolution, and access checks.
type PreferenceService struct {
	logger          *zap.Logger
	prefRepo        preferenceStore
	chatRepo        chatLookupStore
	participantRepo participantLookupStore
}

// NewPreferenceService constructs a PreferenceService.
func NewPreferenceService(
	logger *zap.Logger,
	prefRepo preferenceStore,
	chatRepo chatLookupStore,
	participantRepo participantLookupStore,
) *PreferenceService {
	return &PreferenceService{
		logger:          logger,
		prefRepo:        prefRepo,
		chatRepo:        chatRepo,
		participantRepo: participantRepo,
	}
}

// GetAllPreferences returns the user's account preferences and all stored per-chat overrides.
func (s *PreferenceService) GetAllPreferences(ctx context.Context, userID uint) (*AllPreferencesOutput, error) {
	acc, err := s.getOrDefaultAccountPref(ctx, userID)
	if err != nil {
		return nil, err
	}
	chatPrefs, err := s.prefRepo.ListChatPrefs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list chat preferences: %w", err)
	}
	overrides := make([]ChatPreferenceDTO, 0, len(chatPrefs))
	for i := range chatPrefs {
		overrides = append(overrides, toChatPreferenceDTO(&chatPrefs[i]))
	}
	return &AllPreferencesOutput{
		Account:       toAccountPreferenceDTO(acc),
		ChatOverrides: overrides,
	}, nil
}

// GetChatPreferenceWithEffective returns the user's per-chat override and resolved effective settings.
func (s *PreferenceService) GetChatPreferenceWithEffective(
	ctx context.Context,
	userID, chatID uint,
) (*ChatPreferenceDTO, *EffectiveChatPreference, error) {
	if err := s.CheckChatMembership(ctx, chatID, userID); err != nil {
		return nil, nil, err
	}
	acc, err := s.getOrDefaultAccountPref(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	chatPref, err := s.getOrDefaultChatPref(ctx, userID, chatID)
	if err != nil {
		return nil, nil, err
	}
	dto := toChatPreferenceDTO(chatPref)
	eff := ResolveEffectiveChatPreference(chatID, acc, chatPref, nil)
	return &dto, &eff, nil
}

// UpdateAccountPreferences validates and persists a partial update to the user's account preferences.
func (s *PreferenceService) UpdateAccountPreferences(
	ctx context.Context,
	userID uint,
	in AccountPreferenceInput,
) (*AccountPreferenceDTO, error) {
	if err := validateAccountInput(in); err != nil {
		return nil, err
	}
	current, err := s.getOrDefaultAccountPref(ctx, userID)
	if err != nil {
		return nil, err
	}

	expectedVer := current.Version
	if in.ExpectedVersion != nil {
		expectedVer = *in.ExpectedVersion
	}

	next := *current
	applyAccountInput(&next, in)

	saved, err := s.prefRepo.UpsertAccountPrefCAS(ctx, &next, expectedVer)
	if err != nil {
		if errors.Is(err, repositories.ErrPreferenceVersionConflict) && saved != nil {
			dto := toAccountPreferenceDTO(saved)
			return &dto, err
		}
		return nil, err
	}
	dto := toAccountPreferenceDTO(saved)
	return &dto, nil
}

// UpdateChatPreference validates chat membership and persists a partial update to a per-chat preference.
func (s *PreferenceService) UpdateChatPreference(
	ctx context.Context,
	userID, chatID uint,
	in ChatPreferenceInput,
) (*ChatPreferenceDTO, *EffectiveChatPreference, error) {
	if err := s.CheckChatMembership(ctx, chatID, userID); err != nil {
		return nil, nil, err
	}
	if err := validateChatInput(in); err != nil {
		return nil, nil, err
	}

	expectedVer := int64(-1)
	if in.ExpectedVersion != nil {
		expectedVer = *in.ExpectedVersion
	}

	key := strings.TrimSpace(in.IdempotencyKey)
	saved, err := s.prefRepo.UpsertChatPrefCAS(ctx, userID, chatID, expectedVer, key, func(cur *models.UserChatPreference) {
		applyChatInput(cur, in)
	})
	if err != nil {
		if errors.Is(err, repositories.ErrPreferenceVersionConflict) && saved != nil {
			dto := toChatPreferenceDTO(saved)
			return &dto, nil, err
		}
		return nil, nil, err
	}

	acc, err := s.getOrDefaultAccountPref(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	dto := toChatPreferenceDTO(saved)
	eff := ResolveEffectiveChatPreference(chatID, acc, saved, nil)
	return &dto, &eff, nil
}

// ResetChatPreference resets personal overrides for the specified fields (or all fields if empty)
// back to PrefModeInherit so the chat inherits from shared/account settings again.
func (s *PreferenceService) ResetChatPreference(
	ctx context.Context,
	userID, chatID uint,
	fields []string,
) (*ChatPreferenceDTO, *EffectiveChatPreference, error) {
	if err := s.CheckChatMembership(ctx, chatID, userID); err != nil {
		return nil, nil, err
	}

	resetAll := len(fields) == 0
	fieldSet := make(map[string]bool, len(fields))
	for _, f := range fields {
		fieldSet[strings.ToLower(strings.TrimSpace(f))] = true
	}

	saved, err := s.prefRepo.UpsertChatPrefCAS(ctx, userID, chatID, -1, "", func(cur *models.UserChatPreference) {
		if resetAll || fieldSet["theme"] {
			cur.ThemeMode = models.PrefModeInherit
			cur.ThemeID = ""
			cur.ThemeVersion = 0
			cur.Appearance = ""
		}
		if resetAll || fieldSet["wallpaper"] {
			cur.WallpaperMode = models.PrefModeInherit
			cur.WallpaperID = ""
			cur.WallpaperVersion = 0
		}
		if resetAll || fieldSet["sound"] {
			cur.SoundMode = models.PrefModeInherit
			cur.SoundID = ""
			cur.SoundVersion = 0
		}
		if resetAll || fieldSet["muted"] {
			cur.Muted = false
		}
	})
	if err != nil {
		return nil, nil, err
	}

	acc, err := s.getOrDefaultAccountPref(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	dto := toChatPreferenceDTO(saved)
	eff := ResolveEffectiveChatPreference(chatID, acc, saved, nil)
	return &dto, &eff, nil
}

// BulkApplyPreferences applies personalization changes to either "all" chats (account global,
// preserving existing per-chat overrides) or "selected" chats (1..N chats with per-chat status reporting).
func (s *PreferenceService) BulkApplyPreferences(
	ctx context.Context,
	userID uint,
	in BulkApplyInput,
) (*BulkApplyOutput, error) {
	scope := strings.ToLower(strings.TrimSpace(in.Scope))
	if scope != "all" && scope != "selected" {
		return nil, fmt.Errorf("%w: scope must be 'all' or 'selected'", ErrPreferenceValidation)
	}
	visibility := strings.ToLower(strings.TrimSpace(in.Visibility))
	if visibility == "" {
		visibility = "personal"
	}
	if visibility != "personal" && visibility != "propose" {
		return nil, fmt.Errorf("%w: visibility must be 'personal' or 'propose'", ErrPreferenceValidation)
	}

	if scope == "all" {
		return s.bulkApplyAll(ctx, userID, visibility, in)
	}
	return s.bulkApplySelected(ctx, userID, visibility, in)
}

func (s *PreferenceService) bulkApplyAll(
	ctx context.Context,
	userID uint,
	visibility string,
	in BulkApplyInput,
) (*BulkApplyOutput, error) {
	if visibility == "propose" {
		return nil, fmt.Errorf("%w: cannot propose shared chat settings with scope 'all'", ErrPreferenceValidation)
	}
	accIn := AccountPreferenceInput{
		Theme:           in.Theme,
		Appearance:      in.Appearance,
		Wallpaper:       in.Wallpaper,
		Sound:           in.Sound,
		ExpectedVersion: in.ExpectedAccountVersion,
		IdempotencyKey:  in.IdempotencyKey,
	}
	updatedAcc, err := s.UpdateAccountPreferences(ctx, userID, accIn)
	if err != nil {
		return nil, err
	}
	return &BulkApplyOutput{
		Scope:        "all",
		Visibility:   visibility,
		Total:        1,
		AppliedCount: 1,
		FailedCount:  0,
		Account:      updatedAcc,
		Results:      []BulkApplyChatResult{},
	}, nil
}

func (s *PreferenceService) bulkApplySelected(
	ctx context.Context,
	userID uint,
	visibility string,
	in BulkApplyInput,
) (*BulkApplyOutput, error) {
	if len(in.ChatIDs) == 0 {
		return nil, fmt.Errorf("%w: chat_ids is required when scope is 'selected'", ErrPreferenceValidation)
	}
	chatPatch := buildBulkChatPatch(visibility, in)
	if err := validateChatInput(chatPatch); err != nil {
		return nil, err
	}

	seen := make(map[uint]bool, len(in.ChatIDs))
	uniqueChatIDs := make([]uint, 0, len(in.ChatIDs))
	for _, cid := range in.ChatIDs {
		if cid > 0 && !seen[cid] {
			seen[cid] = true
			uniqueChatIDs = append(uniqueChatIDs, cid)
		}
	}

	results := make([]BulkApplyChatResult, 0, len(uniqueChatIDs))
	appliedCount := 0
	failedCount := 0

	for _, cid := range uniqueChatIDs {
		res := s.applySingleSelectedChat(ctx, userID, cid, visibility, chatPatch, in)
		if res.Status == "error" {
			failedCount++
		} else {
			appliedCount++
		}
		results = append(results, res)
	}

	return &BulkApplyOutput{
		Scope:        "selected",
		Visibility:   visibility,
		Total:        len(uniqueChatIDs),
		AppliedCount: appliedCount,
		FailedCount:  failedCount,
		Results:      results,
	}, nil
}

func (s *PreferenceService) applySingleSelectedChat(
	ctx context.Context,
	userID, chatID uint,
	visibility string,
	basePatch ChatPreferenceInput,
	in BulkApplyInput,
) BulkApplyChatResult {
	patch := basePatch
	if in.ChatExpectedVersions != nil {
		if expVer, ok := in.ChatExpectedVersions[chatID]; ok {
			patch.ExpectedVersion = &expVer
		}
	}
	if in.IdempotencyKey != "" {
		patch.IdempotencyKey = fmt.Sprintf("%s:%d", in.IdempotencyKey, chatID)
	}

	pref, eff, err := s.UpdateChatPreference(ctx, userID, chatID, patch)
	if err != nil {
		code := "error"
		switch {
		case errors.Is(err, ErrChatNotFound):
			code = "not_found"
		case errors.Is(err, ErrChatAccessDenied):
			code = "access_denied"
		case errors.Is(err, repositories.ErrPreferenceVersionConflict):
			code = "version_conflict"
		case errors.Is(err, ErrPreferenceValidation):
			code = "validation"
		}
		return BulkApplyChatResult{
			ChatID:     chatID,
			Status:     "error",
			Visibility: visibility,
			Code:       code,
			Error:      err.Error(),
			Preference: pref,
		}
	}

	status := "applied"
	if visibility == "propose" {
		status = "proposed"
	}
	return BulkApplyChatResult{
		ChatID:     chatID,
		Status:     status,
		Visibility: visibility,
		Preference: pref,
		Effective:  eff,
	}
}

func buildBulkChatPatch(visibility string, in BulkApplyInput) ChatPreferenceInput {
	if visibility == "propose" {
		// When proposing shared chat settings, record them as the initiator's accepted
		// shared chat settings without clobbering their personal overrides or other users' prefs.
		return ChatPreferenceInput{
			SharedTheme:      in.Theme,
			SharedAppearance: in.Appearance,
			SharedWallpaper:  in.Wallpaper,
			SharedSound:      in.Sound,
			Muted:            in.Muted,
		}
	}
	return ChatPreferenceInput{
		Theme:      in.Theme,
		Appearance: in.Appearance,
		Wallpaper:  in.Wallpaper,
		Sound:      in.Sound,
		Muted:      in.Muted,
	}
}

// CheckChatMembership verifies that userID is an active member of chatID.
func (s *PreferenceService) CheckChatMembership(ctx context.Context, chatID, userID uint) error {
	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return ErrChatNotFound
	}
	if chat.IsGroup {
		if s.participantRepo == nil {
			return ErrChatAccessDenied
		}
		if _, err := s.participantRepo.FindByUserAndChat(ctx, chatID, userID); err != nil {
			return ErrChatAccessDenied
		}
		return nil
	}
	if !chat.HasUser(userID) {
		return ErrChatAccessDenied
	}
	return nil
}

func (s *PreferenceService) getOrDefaultAccountPref(ctx context.Context, userID uint) (*models.UserPreference, error) {
	pref, err := s.prefRepo.GetAccountPref(ctx, userID)
	if err == nil {
		return pref, nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return models.DefaultUserPreference(userID), nil
	}
	return nil, fmt.Errorf("get account preferences: %w", err)
}

func (s *PreferenceService) getOrDefaultChatPref(ctx context.Context, userID, chatID uint) (*models.UserChatPreference, error) {
	pref, err := s.prefRepo.GetChatPref(ctx, userID, chatID)
	if err == nil {
		return pref, nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return models.DefaultUserChatPreference(userID, chatID), nil
	}
	return nil, fmt.Errorf("get chat preferences: %w", err)
}

func validateAccountInput(in AccountPreferenceInput) error {
	if in.Theme != nil {
		if !isExplicitThemeMode(in.Theme.Mode) || strings.TrimSpace(in.Theme.ID) == "" {
			return fmt.Errorf("%w: account theme requires preset or custom mode with non-empty id", ErrPreferenceValidation)
		}
	}
	if in.Appearance != nil && !isValidAppearance(*in.Appearance) {
		return fmt.Errorf("%w: invalid appearance mode", ErrPreferenceValidation)
	}
	if in.Wallpaper != nil {
		if !isExplicitWallpaperMode(in.Wallpaper.Mode) {
			return fmt.Errorf("%w: invalid account wallpaper mode", ErrPreferenceValidation)
		}
		if (in.Wallpaper.Mode == models.PrefModePreset || in.Wallpaper.Mode == models.PrefModeCustom) && strings.TrimSpace(in.Wallpaper.ID) == "" {
			return fmt.Errorf("%w: wallpaper preset/custom requires non-empty id", ErrPreferenceValidation)
		}
	}
	if in.Sound != nil {
		if !isExplicitSoundMode(in.Sound.Mode) {
			return fmt.Errorf("%w: invalid account sound mode", ErrPreferenceValidation)
		}
		if (in.Sound.Mode == models.PrefModePreset || in.Sound.Mode == models.PrefModeCustom) && strings.TrimSpace(in.Sound.ID) == "" {
			return fmt.Errorf("%w: sound preset/custom requires non-empty id", ErrPreferenceValidation)
		}
	}
	return nil
}

func validateChatInput(in ChatPreferenceInput) error {
	if err := validateChatThemePatch(in.Theme); err != nil {
		return err
	}
	if err := validateChatThemePatch(in.SharedTheme); err != nil {
		return err
	}
	if in.Appearance != nil && *in.Appearance != "" && !isValidAppearance(*in.Appearance) {
		return fmt.Errorf("%w: invalid appearance mode", ErrPreferenceValidation)
	}
	if in.SharedAppearance != nil && *in.SharedAppearance != "" && !isValidAppearance(*in.SharedAppearance) {
		return fmt.Errorf("%w: invalid shared appearance mode", ErrPreferenceValidation)
	}
	if err := validateChatWallpaperPatch(in.Wallpaper); err != nil {
		return err
	}
	if err := validateChatWallpaperPatch(in.SharedWallpaper); err != nil {
		return err
	}
	if err := validateChatSoundPatch(in.Sound); err != nil {
		return err
	}
	return validateChatSoundPatch(in.SharedSound)
}

func validateChatThemePatch(p *FieldPatch) error {
	if p == nil {
		return nil
	}
	if p.Mode == models.PrefModeInherit {
		return nil
	}
	if !isExplicitThemeMode(p.Mode) || strings.TrimSpace(p.ID) == "" {
		return fmt.Errorf("%w: chat theme must be inherit, preset, or custom with id", ErrPreferenceValidation)
	}
	return nil
}

func validateChatWallpaperPatch(p *FieldPatch) error {
	if p == nil {
		return nil
	}
	if p.Mode == models.PrefModeInherit || p.Mode == models.PrefModeNone {
		return nil
	}
	if (p.Mode == models.PrefModePreset || p.Mode == models.PrefModeCustom) && strings.TrimSpace(p.ID) != "" {
		return nil
	}
	return fmt.Errorf("%w: invalid chat wallpaper mode or missing id", ErrPreferenceValidation)
}

func validateChatSoundPatch(p *FieldPatch) error {
	if p == nil {
		return nil
	}
	if p.Mode == models.PrefModeInherit || p.Mode == models.PrefModeNone || p.Mode == models.PrefModeSystem {
		return nil
	}
	if (p.Mode == models.PrefModePreset || p.Mode == models.PrefModeCustom) && strings.TrimSpace(p.ID) != "" {
		return nil
	}
	return fmt.Errorf("%w: invalid chat sound mode or missing id", ErrPreferenceValidation)
}

func applyAccountInput(target *models.UserPreference, in AccountPreferenceInput) {
	if in.Theme != nil {
		target.ThemeMode = in.Theme.Mode
		target.ThemeID = strings.TrimSpace(in.Theme.ID)
		target.ThemeVersion = resolvePatchVersion(in.Theme.Version, 1)
	}
	if in.Appearance != nil {
		target.Appearance = *in.Appearance
	}
	if in.Wallpaper != nil {
		target.WallpaperMode = in.Wallpaper.Mode
		if in.Wallpaper.Mode == models.PrefModeNone {
			target.WallpaperID = ""
			target.WallpaperVersion = 0
		} else {
			target.WallpaperID = strings.TrimSpace(in.Wallpaper.ID)
			target.WallpaperVersion = resolvePatchVersion(in.Wallpaper.Version, 1)
		}
	}
	if in.Sound != nil {
		target.SoundMode = in.Sound.Mode
		if in.Sound.Mode == models.PrefModeNone || in.Sound.Mode == models.PrefModeSystem {
			target.SoundID = ""
			target.SoundVersion = 0
		} else {
			target.SoundID = strings.TrimSpace(in.Sound.ID)
			target.SoundVersion = resolvePatchVersion(in.Sound.Version, 1)
		}
	}
	if in.NotificationsEnabled != nil {
		target.NotificationsEnabled = *in.NotificationsEnabled
	}
	if len(in.ExtraFields) > 0 {
		target.ExtraFieldsJSON = mergeExtraFieldsJSON(target.ExtraFieldsJSON, in.ExtraFields)
	}
	if key := strings.TrimSpace(in.IdempotencyKey); key != "" {
		target.LastIdempotencyKey = key
	}
}

func applyChatInput(target *models.UserChatPreference, in ChatPreferenceInput) {
	applyFieldTriplet(in.Theme, &target.ThemeMode, &target.ThemeID, &target.ThemeVersion)
	if in.Appearance != nil {
		target.Appearance = *in.Appearance
	} else if in.Theme != nil && in.Theme.Mode == models.PrefModeInherit {
		target.Appearance = ""
	}
	applyFieldTriplet(in.Wallpaper, &target.WallpaperMode, &target.WallpaperID, &target.WallpaperVersion)
	applyFieldTriplet(in.Sound, &target.SoundMode, &target.SoundID, &target.SoundVersion)
	if in.Muted != nil {
		target.Muted = *in.Muted
	}

	applyFieldTriplet(in.SharedTheme, &target.SharedThemeMode, &target.SharedThemeID, &target.SharedThemeVersion)
	if in.SharedAppearance != nil {
		target.SharedAppearance = *in.SharedAppearance
	} else if in.SharedTheme != nil && in.SharedTheme.Mode == models.PrefModeInherit {
		target.SharedAppearance = ""
	}
	applyFieldTriplet(in.SharedWallpaper, &target.SharedWallpaperMode, &target.SharedWallpaperID, &target.SharedWallpaperVersion)
	applyFieldTriplet(in.SharedSound, &target.SharedSoundMode, &target.SharedSoundID, &target.SharedSoundVersion)

	if len(in.ExtraFields) > 0 {
		target.ExtraFieldsJSON = mergeExtraFieldsJSON(target.ExtraFieldsJSON, in.ExtraFields)
	}
}

func applyFieldTriplet(
	patch *FieldPatch,
	mode *models.PreferenceValueMode,
	id *string,
	ver *int,
) {
	if patch == nil {
		return
	}
	*mode = patch.Mode
	if patch.Mode == models.PrefModeInherit || patch.Mode == models.PrefModeNone || patch.Mode == models.PrefModeSystem {
		*id = ""
		*ver = 0
		return
	}
	*id = strings.TrimSpace(patch.ID)
	*ver = resolvePatchVersion(patch.Version, 1)
}

func resolvePatchVersion(v *int, defaultVer int) int {
	if v != nil && *v > 0 {
		return *v
	}
	return defaultVer
}

func parseExtraFieldsJSON(raw string) map[string]any {
	if raw == "" || raw == "{}" {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil || len(out) == 0 {
		return nil
	}
	return out
}

func mergeExtraFieldsJSON(existingRaw string, incoming map[string]any) string {
	merged := parseExtraFieldsJSON(existingRaw)
	if merged == nil {
		merged = make(map[string]any, len(incoming))
	}
	for k, v := range incoming {
		merged[k] = v
	}
	b, err := json.Marshal(merged)
	if err != nil {
		return existingRaw
	}
	return string(b)
}

func toAccountPreferenceDTO(p *models.UserPreference) AccountPreferenceDTO {
	if p == nil {
		return AccountPreferenceDTO{}
	}
	return AccountPreferenceDTO{
		UserPreference: *p,
		ExtraFields:    parseExtraFieldsJSON(p.ExtraFieldsJSON),
	}
}

func toChatPreferenceDTO(p *models.UserChatPreference) ChatPreferenceDTO {
	if p == nil {
		return ChatPreferenceDTO{}
	}
	return ChatPreferenceDTO{
		UserChatPreference: *p,
		ExtraFields:        parseExtraFieldsJSON(p.ExtraFieldsJSON),
	}
}
