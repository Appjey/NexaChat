package models

import "time"

// PreferenceValueMode defines how a preference field (theme, wallpaper, sound) is resolved.
type PreferenceValueMode string

const (
	// PrefModeInherit inherits from the next tier in the resolution chain
	// (chat override -> accepted shared chat pref -> account global -> built-in default).
	PrefModeInherit PreferenceValueMode = "inherit"
	// PrefModePreset selects a built-in catalog item by ID.
	PrefModePreset PreferenceValueMode = "preset"
	// PrefModeCustom selects a user-defined custom theme/wallpaper/sound.
	PrefModeCustom PreferenceValueMode = "custom"
	// PrefModeNone explicitly disables wallpaper ("Без фона") or sound ("Без звука" / silent).
	// Distinct from PrefModeInherit: none/silent stops inheritance and applies no wallpaper/sound.
	PrefModeNone PreferenceValueMode = "none"
	// PrefModeSystem uses the OS/system setting (e.g., system notification sound).
	PrefModeSystem PreferenceValueMode = "system"
)

// AppearanceMode controls whether the theme uses its light or dark variant, or follows OS.
type AppearanceMode string

const (
	AppearanceSystem AppearanceMode = "system"
	AppearanceLight  AppearanceMode = "light"
	AppearanceDark   AppearanceMode = "dark"
)

// UserPreference stores account-wide personalization settings synchronized across devices.
type UserPreference struct {
	UserID    uint      `gorm:"primaryKey;autoIncrement:false" json:"user_id"`
	Version   int64     `gorm:"not null;default:1" json:"version"`
	UpdatedAt time.Time `json:"updated_at"`

	// Theme fields
	ThemeMode    PreferenceValueMode `gorm:"type:varchar(24);not null;default:'preset'" json:"theme_mode"`
	ThemeID      string              `gorm:"type:varchar(100);not null;default:'nexachat'" json:"theme_id"`
	ThemeVersion int                 `gorm:"not null;default:1" json:"theme_version"`
	Appearance   AppearanceMode      `gorm:"type:varchar(16);not null;default:'dark'" json:"appearance"`

	// Wallpaper fields
	WallpaperMode    PreferenceValueMode `gorm:"type:varchar(24);not null;default:'none'" json:"wallpaper_mode"`
	WallpaperID      string              `gorm:"type:varchar(100);not null;default:''" json:"wallpaper_id"`
	WallpaperVersion int                 `gorm:"not null;default:0" json:"wallpaper_version"`

	// Notification sound fields
	SoundMode    PreferenceValueMode `gorm:"type:varchar(24);not null;default:'preset'" json:"sound_mode"`
	SoundID      string              `gorm:"type:varchar(100);not null;default:'nexa'" json:"sound_id"`
	SoundVersion int                 `gorm:"not null;default:1" json:"sound_version"`

	// NotificationsEnabled stores the account-level preference for notifications
	// (distinct from OS/browser device permissions and DND, which remain local).
	NotificationsEnabled bool `gorm:"not null;default:true" json:"notifications_enabled"`

	// ExtraFieldsJSON preserves unknown JSON fields sent by newer clients so an older
	// server/client round-trip does not strip forward-compatible properties.
	ExtraFieldsJSON string `gorm:"type:text;not null;default:'{}'" json:"-"`

	// LastIdempotencyKey guards against duplicate retries.
	LastIdempotencyKey string `gorm:"type:varchar(128)" json:"-"`
}

// UserChatPreference stores per-user, per-chat personalization overrides and accepted shared values.
type UserChatPreference struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	UserID    uint      `gorm:"uniqueIndex:idx_user_chat_pref;not null" json:"user_id"`
	ChatID    uint      `gorm:"uniqueIndex:idx_user_chat_pref;not null;index:idx_chat_pref_chat" json:"chat_id"`
	Version   int64     `gorm:"not null;default:1" json:"version"`
	UpdatedAt time.Time `json:"updated_at"`

	// Personal per-chat overrides (PrefModeInherit means no personal override for that field).
	ThemeMode    PreferenceValueMode `gorm:"type:varchar(24);not null;default:'inherit'" json:"theme_mode"`
	ThemeID      string              `gorm:"type:varchar(100);not null;default:''" json:"theme_id"`
	ThemeVersion int                 `gorm:"not null;default:0" json:"theme_version"`
	Appearance   AppearanceMode      `gorm:"type:varchar(16);not null;default:''" json:"appearance,omitempty"`

	WallpaperMode    PreferenceValueMode `gorm:"type:varchar(24);not null;default:'inherit'" json:"wallpaper_mode"`
	WallpaperID      string              `gorm:"type:varchar(100);not null;default:''" json:"wallpaper_id"`
	WallpaperVersion int                 `gorm:"not null;default:0" json:"wallpaper_version"`

	SoundMode    PreferenceValueMode `gorm:"type:varchar(24);not null;default:'inherit'" json:"sound_mode"`
	SoundID      string              `gorm:"type:varchar(100);not null;default:''" json:"sound_id"`
	SoundVersion int                 `gorm:"not null;default:0" json:"sound_version"`

	// Muted is per-user per-chat notification mute (takes priority over sound settings).
	Muted bool `gorm:"not null;default:false" json:"muted"`

	// Accepted shared chat values (populated when the user accepts a shared chat proposal).
	// Priority resolution:
	//   personal chat override -> accepted shared chat value -> account global -> built-in default
	SharedThemeMode    PreferenceValueMode `gorm:"type:varchar(24);not null;default:'inherit'" json:"shared_theme_mode"`
	SharedThemeID      string              `gorm:"type:varchar(100);not null;default:''" json:"shared_theme_id"`
	SharedThemeVersion int                 `gorm:"not null;default:0" json:"shared_theme_version"`
	SharedAppearance   AppearanceMode      `gorm:"type:varchar(16);not null;default:''" json:"shared_appearance,omitempty"`

	SharedWallpaperMode    PreferenceValueMode `gorm:"type:varchar(24);not null;default:'inherit'" json:"shared_wallpaper_mode"`
	SharedWallpaperID      string              `gorm:"type:varchar(100);not null;default:''" json:"shared_wallpaper_id"`
	SharedWallpaperVersion int                 `gorm:"not null;default:0" json:"shared_wallpaper_version"`

	SharedSoundMode    PreferenceValueMode `gorm:"type:varchar(24);not null;default:'inherit'" json:"shared_sound_mode"`
	SharedSoundID      string              `gorm:"type:varchar(100);not null;default:''" json:"shared_sound_id"`
	SharedSoundVersion int                 `gorm:"not null;default:0" json:"shared_sound_version"`

	ExtraFieldsJSON    string `gorm:"type:text;not null;default:'{}'" json:"-"`
	LastIdempotencyKey string `gorm:"type:varchar(128)" json:"-"`
}

// DefaultUserPreference returns the built-in default account preferences for a user.
func DefaultUserPreference(userID uint) *UserPreference {
	return &UserPreference{
		UserID:               userID,
		Version:              0,
		ThemeMode:            PrefModePreset,
		ThemeID:              "nexachat",
		ThemeVersion:         1,
		Appearance:           AppearanceDark,
		WallpaperMode:        PrefModeNone,
		WallpaperID:          "",
		WallpaperVersion:     0,
		SoundMode:            PrefModePreset,
		SoundID:              "nexa",
		SoundVersion:         1,
		NotificationsEnabled: true,
		ExtraFieldsJSON:      "{}",
	}
}

// DefaultUserChatPreference returns the default (all-inherit) per-chat preference record.
func DefaultUserChatPreference(userID, chatID uint) *UserChatPreference {
	return &UserChatPreference{
		UserID:                 userID,
		ChatID:                 chatID,
		Version:                0,
		ThemeMode:              PrefModeInherit,
		WallpaperMode:          PrefModeInherit,
		SoundMode:              PrefModeInherit,
		Muted:                  false,
		SharedThemeMode:        PrefModeInherit,
		SharedWallpaperMode:    PrefModeInherit,
		SharedSoundMode:        PrefModeInherit,
		ExtraFieldsJSON:        "{}",
	}
}
