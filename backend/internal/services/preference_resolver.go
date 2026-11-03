package services

import "messenger/internal/models"

// ResolutionSource identifies which tier won during priority resolution.
type ResolutionSource string

const (
	SourcePersonalOverride ResolutionSource = "personal_override"
	SourceAcceptedShared   ResolutionSource = "accepted_shared"
	SourceAccountGlobal    ResolutionSource = "account_global"
	SourceBuiltInDefault   ResolutionSource = "builtin_default"
)

// ResolvedField represents the effective value of a single preference field
// (theme, wallpaper, or sound) after priority resolution and catalog fallback.
type ResolvedField struct {
	Mode            models.PreferenceValueMode `json:"mode"`
	ID              string                     `json:"id"`
	Version         int                        `json:"version"`
	Source          ResolutionSource           `json:"source"`
	FallbackApplied bool                       `json:"fallback_applied"`
}

// EffectiveChatPreference is the deterministic resolution result for a chat.
// Priority per field:
//  1. personal chat override (when mode != inherit)
//  2. accepted shared chat value (when shared_*_mode != inherit)
//  3. account global preference
//  4. built-in default
type EffectiveChatPreference struct {
	ChatID               uint                  `json:"chat_id"`
	Theme                ResolvedField         `json:"theme"`
	Appearance           models.AppearanceMode `json:"appearance"`
	AppearanceSource     ResolutionSource      `json:"appearance_source"`
	Wallpaper            ResolvedField         `json:"wallpaper"`
	Sound                ResolvedField         `json:"sound"`
	NotificationsEnabled bool                  `json:"notifications_enabled"`
	Muted                bool                  `json:"muted"`
}

// LastKnownGoodPrefs holds optional last-known-good preset/custom values on a device
// for safe fallback when a newly synced preset ID or custom asset is unavailable.
type LastKnownGoodPrefs struct {
	ThemeID      string
	Appearance   models.AppearanceMode
	WallpaperMode models.PreferenceValueMode
	WallpaperID  string
	SoundMode    models.PreferenceValueMode
	SoundID      string
}

var (
	builtInThemes = map[string]bool{
		"nexachat":     true,
		"classic-blue": true,
		"graphite":     true,
		"lavender":     true,
		"ocean":        true,
		"forest":       true,
	}

	builtInWallpapers = map[string]bool{
		"solid-midnight": true,
		"solid-slate":    true,
		"solid-sage":     true,
		"solid-sand":     true,
		"grad-aurora":    true,
		"grad-dusk":      true,
		"grad-ocean":     true,
		"grad-forest":    true,
		"pat-dots":       true,
		"pat-grid":       true,
		"pat-waves":      true,
		"pat-diagonal":   true,
	}

	builtInSounds = map[string]bool{
		"nexa":    true,
		"soft":    true,
		"drop":    true,
		"pulse":   true,
		"bell":    true,
		"classic": true,
	}
)

// IsSupportedThemeID reports whether id is a known built-in theme preset.
func IsSupportedThemeID(id string) bool {
	return builtInThemes[id]
}

// IsSupportedWallpaperID reports whether id is a known built-in wallpaper preset.
func IsSupportedWallpaperID(id string) bool {
	return builtInWallpapers[id]
}

// IsSupportedSoundID reports whether id is a known built-in notification sound preset.
func IsSupportedSoundID(id string) bool {
	return builtInSounds[id]
}

// ResolveEffectiveChatPreference resolves theme, wallpaper, sound, and mute settings
// for a given chat without mutating the underlying account or chat preference records.
func ResolveEffectiveChatPreference(
	chatID uint,
	account *models.UserPreference,
	chatPref *models.UserChatPreference,
	lkg *LastKnownGoodPrefs,
) EffectiveChatPreference {
	theme := resolveThemeField(account, chatPref, lkg)
	appearance, appSource := resolveAppearance(account, chatPref, lkg)
	wallpaper := resolveWallpaperField(account, chatPref, lkg)
	sound := resolveSoundField(account, chatPref, lkg)

	notificationsEnabled := true
	if account != nil {
		notificationsEnabled = account.NotificationsEnabled
	}

	muted := false
	if chatPref != nil {
		muted = chatPref.Muted
	}

	return EffectiveChatPreference{
		ChatID:               chatID,
		Theme:                theme,
		Appearance:           appearance,
		AppearanceSource:     appSource,
		Wallpaper:            wallpaper,
		Sound:                sound,
		NotificationsEnabled: notificationsEnabled,
		Muted:                muted,
	}
}

func resolveThemeField(
	acc *models.UserPreference,
	chatPref *models.UserChatPreference,
	lkg *LastKnownGoodPrefs,
) ResolvedField {
	var raw ResolvedField
	switch {
	case chatPref != nil && isExplicitThemeMode(chatPref.ThemeMode):
		raw = ResolvedField{
			Mode:    chatPref.ThemeMode,
			ID:      chatPref.ThemeID,
			Version: chatPref.ThemeVersion,
			Source:  SourcePersonalOverride,
		}
	case chatPref != nil && isExplicitThemeMode(chatPref.SharedThemeMode):
		raw = ResolvedField{
			Mode:    chatPref.SharedThemeMode,
			ID:      chatPref.SharedThemeID,
			Version: chatPref.SharedThemeVersion,
			Source:  SourceAcceptedShared,
		}
	case acc != nil && isExplicitThemeMode(acc.ThemeMode):
		raw = ResolvedField{
			Mode:    acc.ThemeMode,
			ID:      acc.ThemeID,
			Version: acc.ThemeVersion,
			Source:  SourceAccountGlobal,
		}
	default:
		return ResolvedField{
			Mode:    models.PrefModePreset,
			ID:      "nexachat",
			Version: 1,
			Source:  SourceBuiltInDefault,
		}
	}

	if raw.Mode == models.PrefModePreset && IsSupportedThemeID(raw.ID) {
		return raw
	}
	if raw.Mode == models.PrefModeCustom && raw.ID != "" && raw.Version > 0 {
		return raw
	}

	// Unsupported preset or unavailable/invalid custom asset -> fallback to lastKnownGood or default.
	fallbackID := "nexachat"
	if lkg != nil && IsSupportedThemeID(lkg.ThemeID) {
		fallbackID = lkg.ThemeID
	}
	return ResolvedField{
		Mode:            models.PrefModePreset,
		ID:              fallbackID,
		Version:         1,
		Source:          raw.Source,
		FallbackApplied: true,
	}
}

func resolveAppearance(
	acc *models.UserPreference,
	chatPref *models.UserChatPreference,
	lkg *LastKnownGoodPrefs,
) (models.AppearanceMode, ResolutionSource) {
	if chatPref != nil && isValidAppearance(chatPref.Appearance) {
		return chatPref.Appearance, SourcePersonalOverride
	}
	if chatPref != nil && isValidAppearance(chatPref.SharedAppearance) {
		return chatPref.SharedAppearance, SourceAcceptedShared
	}
	if acc != nil && isValidAppearance(acc.Appearance) {
		return acc.Appearance, SourceAccountGlobal
	}
	if lkg != nil && isValidAppearance(lkg.Appearance) {
		return lkg.Appearance, SourceBuiltInDefault
	}
	return models.AppearanceDark, SourceBuiltInDefault
}

func resolveWallpaperField(
	acc *models.UserPreference,
	chatPref *models.UserChatPreference,
	lkg *LastKnownGoodPrefs,
) ResolvedField {
	var raw ResolvedField
	switch {
	case chatPref != nil && isExplicitWallpaperMode(chatPref.WallpaperMode):
		raw = ResolvedField{
			Mode:    chatPref.WallpaperMode,
			ID:      chatPref.WallpaperID,
			Version: chatPref.WallpaperVersion,
			Source:  SourcePersonalOverride,
		}
	case chatPref != nil && isExplicitWallpaperMode(chatPref.SharedWallpaperMode):
		raw = ResolvedField{
			Mode:    chatPref.SharedWallpaperMode,
			ID:      chatPref.SharedWallpaperID,
			Version: chatPref.SharedWallpaperVersion,
			Source:  SourceAcceptedShared,
		}
	case acc != nil && isExplicitWallpaperMode(acc.WallpaperMode):
		raw = ResolvedField{
			Mode:    acc.WallpaperMode,
			ID:      acc.WallpaperID,
			Version: acc.WallpaperVersion,
			Source:  SourceAccountGlobal,
		}
	default:
		return ResolvedField{
			Mode:   models.PrefModeNone,
			ID:     "",
			Source: SourceBuiltInDefault,
		}
	}

	if raw.Mode == models.PrefModeNone {
		raw.ID = ""
		return raw
	}
	if raw.Mode == models.PrefModePreset && IsSupportedWallpaperID(raw.ID) {
		return raw
	}
	if raw.Mode == models.PrefModeCustom && raw.ID != "" && raw.Version > 0 {
		return raw
	}

	// Fallback to lastKnownGood or built-in default (none).
	if lkg != nil {
		if lkg.WallpaperMode == models.PrefModeNone {
			return ResolvedField{
				Mode:            models.PrefModeNone,
				ID:              "",
				Source:          raw.Source,
				FallbackApplied: true,
			}
		}
		if lkg.WallpaperMode == models.PrefModePreset && IsSupportedWallpaperID(lkg.WallpaperID) {
			return ResolvedField{
				Mode:            models.PrefModePreset,
				ID:              lkg.WallpaperID,
				Version:         1,
				Source:          raw.Source,
				FallbackApplied: true,
			}
		}
	}
	return ResolvedField{
		Mode:            models.PrefModeNone,
		ID:              "",
		Source:          raw.Source,
		FallbackApplied: true,
	}
}

func resolveSoundField(
	acc *models.UserPreference,
	chatPref *models.UserChatPreference,
	lkg *LastKnownGoodPrefs,
) ResolvedField {
	var raw ResolvedField
	switch {
	case chatPref != nil && isExplicitSoundMode(chatPref.SoundMode):
		raw = ResolvedField{
			Mode:    chatPref.SoundMode,
			ID:      chatPref.SoundID,
			Version: chatPref.SoundVersion,
			Source:  SourcePersonalOverride,
		}
	case chatPref != nil && isExplicitSoundMode(chatPref.SharedSoundMode):
		raw = ResolvedField{
			Mode:    chatPref.SharedSoundMode,
			ID:      chatPref.SharedSoundID,
			Version: chatPref.SharedSoundVersion,
			Source:  SourceAcceptedShared,
		}
	case acc != nil && isExplicitSoundMode(acc.SoundMode):
		raw = ResolvedField{
			Mode:    acc.SoundMode,
			ID:      acc.SoundID,
			Version: acc.SoundVersion,
			Source:  SourceAccountGlobal,
		}
	default:
		return ResolvedField{
			Mode:    models.PrefModePreset,
			ID:      "nexa",
			Version: 1,
			Source:  SourceBuiltInDefault,
		}
	}

	if raw.Mode == models.PrefModeNone || raw.Mode == models.PrefModeSystem {
		raw.ID = ""
		return raw
	}
	if raw.Mode == models.PrefModePreset && IsSupportedSoundID(raw.ID) {
		return raw
	}
	if raw.Mode == models.PrefModeCustom && raw.ID != "" && raw.Version > 0 {
		return raw
	}

	// Fallback to lastKnownGood or built-in default ("nexa").
	if lkg != nil {
		if lkg.SoundMode == models.PrefModeNone || lkg.SoundMode == models.PrefModeSystem {
			return ResolvedField{
				Mode:            lkg.SoundMode,
				ID:              "",
				Source:          raw.Source,
				FallbackApplied: true,
			}
		}
		if lkg.SoundMode == models.PrefModePreset && IsSupportedSoundID(lkg.SoundID) {
			return ResolvedField{
				Mode:            models.PrefModePreset,
				ID:              lkg.SoundID,
				Version:         1,
				Source:          raw.Source,
				FallbackApplied: true,
			}
		}
	}
	return ResolvedField{
		Mode:            models.PrefModePreset,
		ID:              "nexa",
		Version:         1,
		Source:          raw.Source,
		FallbackApplied: true,
	}
}

func isExplicitThemeMode(m models.PreferenceValueMode) bool {
	return m == models.PrefModePreset || m == models.PrefModeCustom
}

func isExplicitWallpaperMode(m models.PreferenceValueMode) bool {
	return m == models.PrefModeNone || m == models.PrefModePreset || m == models.PrefModeCustom
}

func isExplicitSoundMode(m models.PreferenceValueMode) bool {
	return m == models.PrefModeNone || m == models.PrefModeSystem || m == models.PrefModePreset || m == models.PrefModeCustom
}

func isValidAppearance(a models.AppearanceMode) bool {
	return a == models.AppearanceSystem || a == models.AppearanceLight || a == models.AppearanceDark
}
