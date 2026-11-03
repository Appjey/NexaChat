import type { ResolvedThemeVariant } from './types'

type ThemePreset = {
  id: string
  name: string
  description: string
  previewAccent: string
  tokens: Record<ResolvedThemeVariant, Record<string, string>>
}

type WallpaperCategory = 'solid' | 'gradient' | 'pattern'

type WallpaperPreset = {
  id: string
  name: string
  category: WallpaperCategory
  background: Record<ResolvedThemeVariant, string>
  backgroundSize?: string
}

type SoundPreset = {
  id: string
  name: string
  description: string
  notes: number[]
  noteDurationMs: number
  waveform: OscillatorType
}

function buildDarkTokens(p: {
  bgPrimary: string
  bgSecondary: string
  bgSidebar: string
  bgTertiary: string
  bgHover: string
  bgSelected: string
  accent: string
  accentHover: string
  accentDim: string
  accentSelectedText: string
  bubbleOut: string
  bubbleOutBorder: string
  bubbleIn: string
}): Record<string, string> {
  return {
    '--bg-primary': p.bgPrimary,
    '--bg-secondary': p.bgSecondary,
    '--bg-sidebar': p.bgSidebar,
    '--bg-tertiary': p.bgTertiary,
    '--bg-hover': p.bgHover,
    '--bg-elevated': p.bgSecondary,
    '--bg-selected': p.bgSelected,
    '--accent': p.accent,
    '--accent-primary': p.accent,
    '--accent-primary-hover': p.accentHover,
    '--accent-primary-muted': p.accentHover,
    '--accent-primary-subtle': p.accent,
    '--accent-primary-dim': p.accentDim,
    '--accent-selected-text': p.accentSelectedText,
    '--msg-self': p.bubbleOut,
    '--msg-self-hover': p.accentHover,
    '--msg-self-text': '#F2F4FA',
    '--msg-self-meta': 'rgba(242, 244, 250, 0.72)',
    '--msg-other': p.bubbleIn,
    '--bubble-outgoing': p.bubbleOut,
    '--bubble-outgoing-border': p.bubbleOutBorder,
    '--bubble-outgoing-text': '#F2F4FA',
    '--bubble-outgoing-meta': 'rgba(242, 244, 250, 0.72)',
    '--bubble-incoming': p.bubbleIn,
    '--bubble-incoming-border': 'rgba(242, 244, 250, 0.08)',
    '--bubble-incoming-text': '#F2F4FA',
    '--text-primary': '#F2F4FA',
    '--text-secondary': '#A2ABC0',
    '--text-tertiary': '#7A849B',
    '--text-muted': '#7A849B',
    '--border-color': 'rgba(242, 244, 250, 0.08)',
    '--border-light': 'rgba(242, 244, 250, 0.12)',
  }
}

function buildLightTokens(p: {
  bgPrimary: string
  bgSecondary: string
  bgTertiary: string
  bgHover: string
  bgSelected: string
  accent: string
  accentHover: string
  accentDim: string
  accentSelectedText: string
  bubbleOut: string
  bubbleOutBorder: string
  bubbleOutText: string
  bubbleOutMeta: string
}): Record<string, string> {
  return {
    '--bg-primary': p.bgPrimary,
    '--bg-secondary': p.bgSecondary,
    '--bg-sidebar': p.bgSecondary,
    '--bg-tertiary': p.bgTertiary,
    '--bg-hover': p.bgHover,
    '--bg-elevated': p.bgSecondary,
    '--bg-selected': p.bgSelected,
    '--accent': p.accent,
    '--accent-primary': p.accent,
    '--accent-primary-hover': p.accentHover,
    '--accent-primary-muted': p.accentHover,
    '--accent-primary-subtle': p.accent,
    '--accent-primary-dim': p.accentDim,
    '--accent-selected-text': p.accentSelectedText,
    '--msg-self': p.bubbleOut,
    '--msg-self-hover': p.bgSelected,
    '--msg-self-text': p.bubbleOutText,
    '--msg-self-meta': p.bubbleOutMeta,
    '--msg-other': '#FFFFFF',
    '--bubble-outgoing': p.bubbleOut,
    '--bubble-outgoing-border': p.bubbleOutBorder,
    '--bubble-outgoing-text': p.bubbleOutText,
    '--bubble-outgoing-meta': p.bubbleOutMeta,
    '--bubble-incoming': '#FFFFFF',
    '--bubble-incoming-border': 'rgba(15, 23, 42, 0.08)',
    '--bubble-incoming-text': '#161A24',
    '--text-primary': '#161A24',
    '--text-secondary': '#5B6478',
    '--text-tertiary': '#7D879C',
    '--text-muted': '#7D879C',
    '--border-color': '#E3E8F1',
    '--border-light': '#EDF1F7',
  }
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'nexachat',
    name: 'NexaChat',
    description: 'Фирменный контрастный стиль',
    previewAccent: '#7C5CFF',
    tokens: {
      dark: buildDarkTokens({
        bgPrimary: '#0D1017',
        bgSecondary: '#191D28',
        bgSidebar: '#11151F',
        bgTertiary: '#202635',
        bgHover: '#262D3F',
        bgSelected: '#352A53',
        accent: '#7C5CFF',
        accentHover: '#6C4CEB',
        accentDim: 'rgba(124, 92, 255, 0.16)',
        accentSelectedText: '#D7CBFF',
        bubbleOut: '#493B67',
        bubbleOutBorder: 'rgba(124, 92, 255, 0.28)',
        bubbleIn: '#191D28',
      }),
      light: buildLightTokens({
        bgPrimary: '#F0F3F8',
        bgSecondary: '#FFFFFF',
        bgTertiary: '#EEF1F7',
        bgHover: '#E5EAF3',
        bgSelected: '#EAE2FC',
        accent: '#7C5CFF',
        accentHover: '#6846F0',
        accentDim: 'rgba(124, 92, 255, 0.12)',
        accentSelectedText: '#5938E8',
        bubbleOut: '#E6DCFA',
        bubbleOutBorder: 'rgba(124, 92, 255, 0.24)',
        bubbleOutText: '#181C26',
        bubbleOutMeta: '#5F557D',
      }),
    },
  },
  {
    id: 'classic-blue',
    name: 'Classic Blue',
    description: 'Классический небесно-синий',
    previewAccent: '#2563EB',
    tokens: {
      dark: buildDarkTokens({
        bgPrimary: '#0B1324',
        bgSecondary: '#132038',
        bgSidebar: '#0E182B',
        bgTertiary: '#1B2C4B',
        bgHover: '#23385E',
        bgSelected: '#1E3A8A',
        accent: '#3B82F6',
        accentHover: '#2563EB',
        accentDim: 'rgba(59, 130, 246, 0.18)',
        accentSelectedText: '#BFDBFE',
        bubbleOut: '#1D4ED8',
        bubbleOutBorder: 'rgba(96, 165, 250, 0.35)',
        bubbleIn: '#162440',
      }),
      light: buildLightTokens({
        bgPrimary: '#EFF6FF',
        bgSecondary: '#FFFFFF',
        bgTertiary: '#DBEAFE',
        bgHover: '#BFDBFE',
        bgSelected: '#DBEAFE',
        accent: '#2563EB',
        accentHover: '#1D4ED8',
        accentDim: 'rgba(37, 99, 235, 0.14)',
        accentSelectedText: '#1E40AF',
        bubbleOut: '#DBEAFE',
        bubbleOutBorder: 'rgba(37, 99, 235, 0.25)',
        bubbleOutText: '#1E3A8A',
        bubbleOutMeta: '#3B82F6',
      }),
    },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Строгий монохромный графит',
    previewAccent: '#64748B',
    tokens: {
      dark: buildDarkTokens({
        bgPrimary: '#111315',
        bgSecondary: '#1A1D21',
        bgSidebar: '#14171A',
        bgTertiary: '#24292E',
        bgHover: '#2E343B',
        bgSelected: '#334155',
        accent: '#94A3B8',
        accentHover: '#64748B',
        accentDim: 'rgba(148, 163, 184, 0.18)',
        accentSelectedText: '#F1F5F9',
        bubbleOut: '#334155',
        bubbleOutBorder: 'rgba(148, 163, 184, 0.3)',
        bubbleIn: '#1E2227',
      }),
      light: buildLightTokens({
        bgPrimary: '#F1F5F9',
        bgSecondary: '#FFFFFF',
        bgTertiary: '#E2E8F0',
        bgHover: '#CBD5E1',
        bgSelected: '#E2E8F0',
        accent: '#475569',
        accentHover: '#334155',
        accentDim: 'rgba(71, 85, 105, 0.14)',
        accentSelectedText: '#0F172A',
        bubbleOut: '#E2E8F0',
        bubbleOutBorder: 'rgba(71, 85, 105, 0.25)',
        bubbleOutText: '#0F172A',
        bubbleOutMeta: '#475569',
      }),
    },
  },
  {
    id: 'lavender',
    name: 'Lavender',
    description: 'Мягкие лавандовые оттенки',
    previewAccent: '#A855F7',
    tokens: {
      dark: buildDarkTokens({
        bgPrimary: '#160F24',
        bgSecondary: '#221738',
        bgSidebar: '#1B122C',
        bgTertiary: '#2E1F4B',
        bgHover: '#3B285F',
        bgSelected: '#4C1D95',
        accent: '#C084FC',
        accentHover: '#A855F7',
        accentDim: 'rgba(192, 132, 252, 0.18)',
        accentSelectedText: '#F3E8FF',
        bubbleOut: '#581C87',
        bubbleOutBorder: 'rgba(192, 132, 252, 0.35)',
        bubbleIn: '#26193E',
      }),
      light: buildLightTokens({
        bgPrimary: '#FAF5FF',
        bgSecondary: '#FFFFFF',
        bgTertiary: '#F3E8FF',
        bgHover: '#E9D5FF',
        bgSelected: '#F3E8FF',
        accent: '#9333EA',
        accentHover: '#7E22CE',
        accentDim: 'rgba(147, 51, 234, 0.14)',
        accentSelectedText: '#6B21A8',
        bubbleOut: '#F3E8FF',
        bubbleOutBorder: 'rgba(147, 51, 234, 0.25)',
        bubbleOutText: '#3B0764',
        bubbleOutMeta: '#7E22CE',
      }),
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Глубокий бирюзовый океан',
    previewAccent: '#06B6D4',
    tokens: {
      dark: buildDarkTokens({
        bgPrimary: '#071921',
        bgSecondary: '#0E2936',
        bgSidebar: '#0A202B',
        bgTertiary: '#15394A',
        bgHover: '#1B495E',
        bgSelected: '#155E75',
        accent: '#22D3EE',
        accentHover: '#06B6D4',
        accentDim: 'rgba(34, 211, 238, 0.18)',
        accentSelectedText: '#CFFAFE',
        bubbleOut: '#0E7490',
        bubbleOutBorder: 'rgba(34, 211, 238, 0.35)',
        bubbleIn: '#11303F',
      }),
      light: buildLightTokens({
        bgPrimary: '#ECFEFF',
        bgSecondary: '#FFFFFF',
        bgTertiary: '#CFFAFE',
        bgHover: '#A5F3FC',
        bgSelected: '#CFFAFE',
        accent: '#0891B2',
        accentHover: '#0E7490',
        accentDim: 'rgba(8, 145, 178, 0.14)',
        accentSelectedText: '#155E75',
        bubbleOut: '#CFFAFE',
        bubbleOutBorder: 'rgba(8, 145, 178, 0.25)',
        bubbleOutText: '#164E63',
        bubbleOutMeta: '#0E7490',
      }),
    },
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Спокойный изумрудный лес',
    previewAccent: '#10B981',
    tokens: {
      dark: buildDarkTokens({
        bgPrimary: '#071A14',
        bgSecondary: '#0E2B22',
        bgSidebar: '#0A221B',
        bgTertiary: '#163D31',
        bgHover: '#1E4E3F',
        bgSelected: '#065F46',
        accent: '#34D399',
        accentHover: '#10B981',
        accentDim: 'rgba(52, 211, 153, 0.18)',
        accentSelectedText: '#D1FAE5',
        bubbleOut: '#047857',
        bubbleOutBorder: 'rgba(52, 211, 153, 0.35)',
        bubbleIn: '#113328',
      }),
      light: buildLightTokens({
        bgPrimary: '#ECFDF5',
        bgSecondary: '#FFFFFF',
        bgTertiary: '#D1FAE5',
        bgHover: '#A7F3D0',
        bgSelected: '#D1FAE5',
        accent: '#059669',
        accentHover: '#047857',
        accentDim: 'rgba(5, 150, 105, 0.14)',
        accentSelectedText: '#065F46',
        bubbleOut: '#D1FAE5',
        bubbleOutBorder: 'rgba(5, 150, 105, 0.25)',
        bubbleOutText: '#064E3B',
        bubbleOutMeta: '#047857',
      }),
    },
  },
]

export const WALLPAPER_PRESETS: WallpaperPreset[] = [
  {
    id: 'solid-midnight',
    name: 'Полуночный',
    category: 'solid',
    background: {
      dark: '#060913',
      light: '#DDE7F5',
    },
  },
  {
    id: 'solid-slate',
    name: 'Сланцевый',
    category: 'solid',
    background: {
      dark: '#18181B',
      light: '#E2E8F0',
    },
  },
  {
    id: 'solid-sage',
    name: 'Шалфей',
    category: 'solid',
    background: {
      dark: '#0D261C',
      light: '#D1FAE5',
    },
  },
  {
    id: 'solid-sand',
    name: 'Песочный',
    category: 'solid',
    background: {
      dark: '#29211B',
      light: '#FEF3C7',
    },
  },
  {
    id: 'grad-aurora',
    name: 'Северное сияние',
    category: 'gradient',
    background: {
      dark: 'linear-gradient(135deg, #0f172a 0%, #31105f 50%, #064e3b 100%)',
      light: 'linear-gradient(135deg, #e0e7ff 0%, #f3e8ff 50%, #d1fae5 100%)',
    },
  },
  {
    id: 'grad-dusk',
    name: 'Сумерки',
    category: 'gradient',
    background: {
      dark: 'linear-gradient(135deg, #2a1245 0%, #4c1d95 50%, #0f172a 100%)',
      light: 'linear-gradient(135deg, #fce7f3 0%, #f3e8ff 50%, #dbeafe 100%)',
    },
  },
  {
    id: 'grad-ocean',
    name: 'Океанский бриз',
    category: 'gradient',
    background: {
      dark: 'linear-gradient(135deg, #082f49 0%, #0e7490 50%, #0f172a 100%)',
      light: 'linear-gradient(135deg, #e0f2fe 0%, #a5f3fc 50%, #f1f5f9 100%)',
    },
  },
  {
    id: 'grad-forest',
    name: 'Хвойный туман',
    category: 'gradient',
    background: {
      dark: 'linear-gradient(135deg, #022c22 0%, #065f46 50%, #0f172a 100%)',
      light: 'linear-gradient(135deg, #dcfce7 0%, #a7f3d0 50%, #f0fdf4 100%)',
    },
  },
  {
    id: 'pat-dots',
    name: 'Точки',
    category: 'pattern',
    background: {
      dark: 'radial-gradient(rgba(255, 255, 255, 0.14) 1.5px, transparent 1.5px), #0f172a',
      light: 'radial-gradient(rgba(15, 23, 42, 0.14) 1.5px, transparent 1.5px), #f8fafc',
    },
    backgroundSize: '20px 20px',
  },
  {
    id: 'pat-grid',
    name: 'Сетка',
    category: 'pattern',
    background: {
      dark: 'linear-gradient(rgba(255,255,255,0.07) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.07) 1px, transparent 1px), #111827',
      light: 'linear-gradient(rgba(15,23,42,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.08) 1px, transparent 1px), #f8fafc',
    },
    backgroundSize: '24px 24px',
  },
  {
    id: 'pat-waves',
    name: 'Волны',
    category: 'pattern',
    background: {
      dark: 'repeating-radial-gradient(circle at 0 0, transparent 0, #0f172a 16px), repeating-linear-gradient(#1e293b88, #334155)',
      light: 'repeating-radial-gradient(circle at 0 0, transparent 0, #f8fafc 16px), repeating-linear-gradient(#cbd5e188, #e2e8f0)',
    },
  },
  {
    id: 'pat-diagonal',
    name: 'Диагональ',
    category: 'pattern',
    background: {
      dark: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 2px, transparent 2px, transparent 12px), #0f172a',
      light: 'repeating-linear-gradient(45deg, rgba(15,23,42,0.07) 0px, rgba(15,23,42,0.07) 2px, transparent 2px, transparent 12px), #f8fafc',
    },
  },
]

export const SOUND_PRESETS: SoundPreset[] = [
  {
    id: 'nexa',
    name: 'Nexa',
    description: 'Фирменный двойной аккорд',
    notes: [587.33, 880],
    noteDurationMs: 110,
    waveform: 'sine',
  },
  {
    id: 'soft',
    name: 'Мягкий',
    description: 'Тёплый деликатный тон',
    notes: [440, 554.37],
    noteDurationMs: 130,
    waveform: 'sine',
  },
  {
    id: 'drop',
    name: 'Капля',
    description: 'Короткий чистый всплеск',
    notes: [783.99, 1046.5],
    noteDurationMs: 80,
    waveform: 'triangle',
  },
  {
    id: 'pulse',
    name: 'Импульс',
    description: 'Ритмичный двойной сигнал',
    notes: [659.25, 659.25, 987.77],
    noteDurationMs: 75,
    waveform: 'sine',
  },
  {
    id: 'bell',
    name: 'Колокольчик',
    description: 'Звонкий высокий перелив',
    notes: [1046.5, 1318.5],
    noteDurationMs: 120,
    waveform: 'sine',
  },
  {
    id: 'classic',
    name: 'Классический',
    description: 'Традиционный трезвучный сигнал',
    notes: [523.25, 659.25, 783.99],
    noteDurationMs: 95,
    waveform: 'triangle',
  },
]

const THEME_BY_ID = new Map(THEME_PRESETS.map((t) => [t.id, t]))
const WALLPAPER_BY_ID = new Map(WALLPAPER_PRESETS.map((w) => [w.id, w]))
const SOUND_BY_ID = new Map(SOUND_PRESETS.map((s) => [s.id, s]))

export function getThemePreset(id: string): ThemePreset | undefined {
  return THEME_BY_ID.get(id)
}

export function getWallpaperPreset(id: string): WallpaperPreset | undefined {
  return WALLPAPER_BY_ID.get(id)
}

function getSoundPreset(id: string): SoundPreset | undefined {
  return SOUND_BY_ID.get(id)
}

export function isSupportedThemePreset(id: string): boolean {
  return THEME_BY_ID.has(id)
}

export function isSupportedWallpaperPreset(id: string): boolean {
  return WALLPAPER_BY_ID.has(id)
}

export function isSupportedSoundPreset(id: string): boolean {
  return SOUND_BY_ID.has(id)
}

/**
 * Plays a short synthesized notification tone using Web Audio API.
 * Used ONLY on explicit user preview click or on live incoming messages when allowed.
 */
export function playSoundTone(soundId: string): boolean {
  const preset = getSoundPreset(soundId) ?? getSoundPreset('nexa')
  if (!preset || typeof window === 'undefined') return false

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) return false

  try {
    const ctx = new AudioCtx()
    const now = ctx.currentTime
    const stepSec = preset.noteDurationMs / 1000

    preset.notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = preset.waveform
      osc.frequency.setValueAtTime(freq, now + idx * stepSec)

      gain.gain.setValueAtTime(0.001, now + idx * stepSec)
      gain.gain.exponentialRampToValueAtTime(0.14, now + idx * stepSec + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (idx + 1) * stepSec)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + idx * stepSec)
      osc.stop(now + (idx + 1) * stepSec + 0.01)
    })

    const totalMs = preset.notes.length * preset.noteDurationMs + 100
    setTimeout(() => {
      void ctx.close().catch(() => {})
    }, totalMs)
    return true
  } catch {
    return false
  }
}
