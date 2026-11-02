import { useState } from 'react'

import { resolveApiUrl } from '../api/httpClient'

// Deterministic moderate color palette matching NexaChat v4 design previews:
// rose, steel blue, warm amber, sage teal, lavender, slate blue, violet, teal-blue
const AVATAR_PALETTE = [
  '#C46D8E',
  '#5386B6',
  '#B07D48',
  '#438D7D',
  '#7E65B8',
  '#587BB4',
  '#7C66DC',
  '#4D8B9C',
]

const FAVORITES_COLOR = '#7C66DC'

function getInitials(name?: string | null, isFavorites?: boolean): string {
  if (isFavorites) return 'И'
  const cleaned = (name || '').replace(/^@/, '').trim()
  if (!cleaned) return '?'
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${Array.from(parts[0])[0] || ''}${Array.from(parts[1])[0] || ''}`.toUpperCase()
  }
  const chars = Array.from(cleaned)
  return (chars[0] || '?').toUpperCase()
}

function getAvatarColor(seed: string | number | undefined, isFavorites?: boolean): string {
  if (isFavorites) return FAVORITES_COLOR
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return AVATAR_PALETTE[Math.abs(seed) % AVATAR_PALETTE.length]
  }
  const str = String(seed || '')
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

type AvatarProps = {
  name?: string | null
  avatarUrl?: string | null
  seed?: string | number
  isFavorites?: boolean
  online?: boolean
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  imgClassName?: string
  alt?: string
}

export function Avatar({
  name,
  avatarUrl,
  seed,
  isFavorites = false,
  online = false,
  size = 'md',
  className = '',
  imgClassName = '',
  alt = 'Avatar',
}: AvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const resolved = !isFavorites ? resolveApiUrl(avatarUrl) : ''
  const showImage = Boolean(resolved && resolved !== failedUrl)
  const bg = getAvatarColor(seed ?? name ?? '', isFavorites)
  const initials = getInitials(name, isFavorites)

  return (
    <span
      className={`avatar avatar-${size} ${showImage ? 'avatar--image' : 'avatar--initials'} ${className}`.trim()}
      style={showImage ? undefined : { backgroundColor: bg }}
      aria-label={alt || name || 'Avatar'}
    >
      {showImage ? (
        <img
          src={resolved}
          alt={alt}
          className={imgClassName || undefined}
          loading="lazy"
          onError={() => setFailedUrl(resolved ?? null)}
        />
      ) : (
        <span className="avatar__initials" aria-hidden="true">
          {initials}
        </span>
      )}
      {online && <span className="avatar__online-dot" aria-hidden="true" />}
    </span>
  )
}
