import './EmojiPicker.css'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CloseIcon } from '../../shared/components/Icons'
import type { EmojiCategory } from './emojiData'
import { EMOJI_CATEGORIES, EMOJI_KEYWORDS } from './emojiData'
import { useRecentEmojis } from './useRecentEmojis'

type Props = {
  onSelect: (emoji: string) => void
  onClose: () => void
}

function CategoryIcon({ id }: { id: string }) {
  switch (id) {
    case 'recent':
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 15.5 14" />
        </svg>
      )
    case 'smileys':
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8" />
          <line x1="9" y1="9.5" x2="9.01" y2="9.5" strokeWidth="2.4" />
          <line x1="15" y1="9.5" x2="15.01" y2="9.5" strokeWidth="2.4" />
        </svg>
      )
    case 'people':
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
        </svg>
      )
    case 'animals':
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
          <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
        </svg>
      )
    case 'food':
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 8h1a4 4 0 1 1 0 8h-1" />
          <path d="M3 8h14v7a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" />
          <line x1="6" y1="2" x2="6" y2="4" />
          <line x1="10" y1="2" x2="10" y2="4" />
          <line x1="14" y1="2" x2="14" y2="4" />
        </svg>
      )
    case 'travel':
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
        </svg>
      )
    case 'activities':
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      )
    case 'objects':
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
          <path d="M9 18h6" />
          <path d="M10 22h4" />
        </svg>
      )
    case 'symbols':
    default:
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
        </svg>
      )
  }
}

export function EmojiPicker({ onSelect, onClose }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const pendingCategoryRef = useRef<string | null>(null)
  const [activeCategory, setActiveCategory] = useState('smileys')
  const [searchQuery, setSearchQuery] = useState('')
  const { recentEmojis, addRecentEmoji } = useRecentEmojis()

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const isSearching = searchQuery.trim().length > 0

  // Pre-build recent category object
  const recentCategory = useMemo<EmojiCategory | null>(
    () =>
      recentEmojis.length > 0
        ? { id: 'recent', name: 'Недавние', icon: '🕐', emojis: recentEmojis }
        : null,
    [recentEmojis],
  )

  // All categories to render (recent + standard)
  const allCategories = useMemo(() => {
    const cats: EmojiCategory[] = []
    if (recentCategory) cats.push(recentCategory)
    cats.push(...EMOJI_CATEGORIES)
    return cats
  }, [recentCategory])

  // Scroll-spy (throttled via rAF)
  useEffect(() => {
    const container = scrollRef.current
    if (!container || isSearching) return

    let rafId = 0
    const handleScroll = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const top = container.scrollTop + 14
        let active = allCategories[0]?.id ?? 'smileys'
        for (const cat of allCategories) {
          const el = sectionRefs.current.get(cat.id)
          if (el && el.offsetTop <= top) {
            active = cat.id
          }
        }
        setActiveCategory((prev) => (prev === active ? prev : active))
      })
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [allCategories, isSearching])

  // Complete deferred category scroll when leaving search mode
  useEffect(() => {
    if (isSearching || !pendingCategoryRef.current) return
    const targetId = pendingCategoryRef.current
    pendingCategoryRef.current = null
    const el = sectionRefs.current.get(targetId)
    const container = scrollRef.current
    if (el && container) {
      container.scrollTop = el.offsetTop
    }
  }, [isSearching])

  // Search filter
  const filteredEmojis = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return []
    const results: string[] = []
    for (const cat of EMOJI_CATEGORIES) {
      for (const emoji of cat.emojis) {
        const kw = EMOJI_KEYWORDS[emoji]
        if (kw?.some((k) => k.includes(q))) {
          results.push(emoji)
        }
      }
    }
    return results
  }, [searchQuery])

  const handleCategoryClick = useCallback(
    (id: string) => {
      setActiveCategory(id)
      if (isSearching) {
        pendingCategoryRef.current = id
        setSearchQuery('')
        return
      }
      const el = sectionRefs.current.get(id)
      const container = scrollRef.current
      if (el && container) {
        container.scrollTop = el.offsetTop
      }
    },
    [isSearching],
  )

  const handleEmojiClick = useCallback(
    (emoji: string) => {
      addRecentEmoji(emoji)
      onSelect(emoji)
    },
    [addRecentEmoji, onSelect],
  )

  const setSectionRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      sectionRefs.current.set(id, el)
    } else {
      sectionRefs.current.delete(id)
    }
  }, [])

  return (
    <aside className="emoji-picker" aria-label="Панель эмодзи">
      {/* Header bar: expression mode switcher slot + close button */}
      <div className="emoji-picker__header">
        <div className="emoji-picker__modes" data-expression-slot="modes">
          <span className="emoji-picker__mode-pill active">Эмодзи</span>
        </div>
        <button
          type="button"
          className="emoji-picker__close-btn"
          onClick={onClose}
          aria-label="Закрыть панель эмодзи"
          title="Закрыть"
        >
          <CloseIcon size={16} />
        </button>
      </div>

      {/* Search bar */}
      <div className="emoji-picker__search-bar">
        <svg
          className="emoji-picker__search-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          width="15"
          height="15"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          type="text"
          className="emoji-picker__search-input"
          placeholder="Поиск эмодзи…"
          aria-label="Поиск эмодзи"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <button
            type="button"
            className="emoji-picker__search-clear"
            aria-label="Очистить поиск"
            onClick={() => setSearchQuery('')}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      {/* Category tabs row (monochrome vector icons) */}
      <div className="emoji-picker__toolbar">
        <div className="emoji-picker__tabs" role="tablist" aria-label="Категории эмодзи">
          {recentCategory && (
            <button
              type="button"
              role="tab"
              aria-selected={!isSearching && activeCategory === 'recent'}
              className={`emoji-picker__tab${!isSearching && activeCategory === 'recent' ? ' active' : ''}`}
              onClick={() => handleCategoryClick('recent')}
              aria-label="Недавние"
              title="Недавние"
            >
              <CategoryIcon id="recent" />
            </button>
          )}
          {EMOJI_CATEGORIES.map((cat) => {
            const isActive = !isSearching && activeCategory === cat.id
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`emoji-picker__tab${isActive ? ' active' : ''}`}
                onClick={() => handleCategoryClick(cat.id)}
                aria-label={cat.name}
                title={cat.name}
              >
                <CategoryIcon id={cat.id} />
              </button>
            )
          })}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="emoji-picker__scroll fancy-scroll" ref={scrollRef}>
        {isSearching ? (
          <>
            {filteredEmojis.length > 0 ? (
              <div className="emoji-picker__section">
                <div className="emoji-picker__section-title">
                  Результаты ({filteredEmojis.length})
                </div>
                <div className="emoji-picker__grid">
                  {filteredEmojis.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="emoji-btn"
                      onClick={() => handleEmojiClick(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="emoji-picker__empty">Ничего не найдено</div>
            )}
          </>
        ) : (
          <>
            {allCategories.map((cat) => (
              <div
                key={cat.id}
                className="emoji-picker__section"
                ref={(el) => setSectionRef(cat.id, el)}
              >
                <div className="emoji-picker__section-title">{cat.name}</div>
                <div className="emoji-picker__grid">
                  {cat.emojis.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="emoji-btn"
                      onClick={() => handleEmojiClick(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
