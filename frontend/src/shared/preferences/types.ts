export type PreferenceValueMode = 'inherit' | 'preset' | 'custom' | 'none' | 'system'

export type AppearanceMode = 'system' | 'light' | 'dark'

export type ResolvedThemeVariant = 'light' | 'dark'

export type ResolutionSource =
  | 'personal_override'
  | 'accepted_shared'
  | 'account_global'
  | 'builtin_default'

export type FieldPatch = {
  mode: PreferenceValueMode
  id?: string
  version?: number
}

export type ResolvedField = {
  mode: PreferenceValueMode
  id: string
  version: number
  source: ResolutionSource
  fallback_applied: boolean
}

export type AccountPreferenceDTO = {
  user_id: number
  version: number
  updated_at?: string
  theme_mode: PreferenceValueMode
  theme_id: string
  theme_version: number
  appearance: AppearanceMode
  wallpaper_mode: PreferenceValueMode
  wallpaper_id: string
  wallpaper_version: number
  sound_mode: PreferenceValueMode
  sound_id: string
  sound_version: number
  notifications_enabled: boolean
  extra_fields?: Record<string, unknown>
}

export type ChatPreferenceDTO = {
  id?: number
  user_id: number
  chat_id: number
  version: number
  updated_at?: string
  theme_mode: PreferenceValueMode
  theme_id: string
  theme_version: number
  appearance?: AppearanceMode | ''
  wallpaper_mode: PreferenceValueMode
  wallpaper_id: string
  wallpaper_version: number
  sound_mode: PreferenceValueMode
  sound_id: string
  sound_version: number
  muted: boolean
  shared_theme_mode: PreferenceValueMode
  shared_theme_id: string
  shared_theme_version: number
  shared_appearance?: AppearanceMode | ''
  shared_wallpaper_mode: PreferenceValueMode
  shared_wallpaper_id: string
  shared_wallpaper_version: number
  shared_sound_mode: PreferenceValueMode
  shared_sound_id: string
  shared_sound_version: number
  extra_fields?: Record<string, unknown>
}

export type EffectiveChatPreference = {
  chat_id: number
  theme: ResolvedField
  appearance: AppearanceMode
  resolved_variant: ResolvedThemeVariant
  appearance_source: ResolutionSource
  wallpaper: ResolvedField
  sound: ResolvedField
  notifications_enabled: boolean
  muted: boolean
}

export type AllPreferencesResponse = {
  account: AccountPreferenceDTO
  chat_overrides: ChatPreferenceDTO[]
}

export type AccountPreferencePatch = {
  theme?: FieldPatch
  appearance?: AppearanceMode
  wallpaper?: FieldPatch
  sound?: FieldPatch
  notifications_enabled?: boolean
  expected_version?: number
  idempotency_key?: string
  extra_fields?: Record<string, unknown>
}

export type ChatPreferencePatch = {
  theme?: FieldPatch
  appearance?: AppearanceMode | ''
  wallpaper?: FieldPatch
  sound?: FieldPatch
  muted?: boolean
  shared_theme?: FieldPatch
  shared_appearance?: AppearanceMode | ''
  shared_wallpaper?: FieldPatch
  shared_sound?: FieldPatch
  expected_version?: number
  idempotency_key?: string
  extra_fields?: Record<string, unknown>
}

export type BulkApplyScope = 'all' | 'selected'
export type BulkApplyVisibility = 'personal' | 'propose'

export type BulkApplyRequest = {
  scope: BulkApplyScope
  visibility: BulkApplyVisibility
  chat_ids?: number[]
  theme?: FieldPatch
  appearance?: AppearanceMode
  wallpaper?: FieldPatch
  sound?: FieldPatch
  muted?: boolean
  expected_account_version?: number
  chat_expected_versions?: Record<number, number>
  idempotency_key?: string
}

export type BulkApplyChatResult = {
  chat_id: number
  status: 'applied' | 'proposed' | 'error'
  visibility?: BulkApplyVisibility
  code?: string
  error?: string
  preference?: ChatPreferenceDTO
  effective?: EffectiveChatPreference
}

export type BulkApplyResponse = {
  scope: BulkApplyScope
  visibility: BulkApplyVisibility
  total: number
  applied_count: number
  failed_count: number
  account?: AccountPreferenceDTO
  results: BulkApplyChatResult[]
}

export type LastKnownGoodPrefs = {
  theme_id: string
  appearance: AppearanceMode
  wallpaper_mode: PreferenceValueMode
  wallpaper_id: string
  sound_mode: PreferenceValueMode
  sound_id: string
}

export type DeviceSoundConstraints = {
  osPermissionDenied?: boolean
  deviceSilentOrDnd?: boolean
  inActiveCall?: boolean
  isReplayed?: boolean
  isOwnMessage?: boolean
}
