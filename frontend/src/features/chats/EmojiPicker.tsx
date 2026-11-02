import './EmojiPicker.css'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

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
          <path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" />
          <circle cx="9" cy="9.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="9.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'people':
      return (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2" />
          <path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v6" />
          <path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" />
          <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
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
  const searchInputRef = useRef<HTMLInputElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const pendingCategoryRef = useRef<string | null>(null)
  const programmaticTargetRef = useRef<{ id: string; until: number } | null>(null)
  const prevRecentHeightRef = useRef<number>(0)
  const wasSearchingRef = useRef<boolean>(false)

  const { recentEmojis, addRecentEmoji } = useRecentEmojis()
  const [activeCategory, setActiveCategory] = useState(() =>
    recentEmojis.length > 0 ? 'recent' : 'smileys',
  )
  const [searchQuery, setSearchQuery] = useState('')

  // Auto-focus search input on desktop (fine pointer) without popping mobile keyboard
  useEffect(() => {
    if (
      typeof window !== 'undefined' &&
      window.innerWidth > 768 &&
      window.matchMedia?.('(pointer: fine)').matches
    ) {
      searchInputRef.current?.focus({ preventScroll: true })
    }
  }, [])

  // Escape to close (or clear search first if focused inside non-empty search input)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (searchQuery.trim().length > 0 && document.activeElement === searchInputRef.current) {
          e.preventDefault()
          setSearchQuery('')
          return
        }
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, searchQuery])

  const isSearching = searchQuery.trim().length > 0

  // Pre-build recent category object (shown when non-empty or explicitly selected)
  const recentCategory = useMemo<EmojiCategory | null>(
    () =>
      recentEmojis.length > 0 || activeCategory === 'recent'
        ? { id: 'recent', name: 'Недавние', icon: '🕐', emojis: recentEmojis }
        : null,
    [recentEmojis, activeCategory],
  )

  // All categories to render in the scroll view
  const allCategories = useMemo(() => {
    const cats: EmojiCategory[] = []
    if (recentCategory) cats.push(recentCategory)
    cats.push(...EMOJI_CATEGORIES)
    return cats
  }, [recentCategory])

  // Prevent layout jump in the scroll container when `recent` section appears or grows
  // while the user is browsing/clicking emojis in another category.
  useLayoutEffect(() => {
    if (isSearching) return
    const recentEl = sectionRefs.current.get('recent')
    const newHeight = recentEl ? recentEl.offsetHeight : 0
    const prevHeight = prevRecentHeightRef.current
    prevRecentHeightRef.current = newHeight

    const container = scrollRef.current
    if (!container) return
    const delta = newHeight - prevHeight
    if (delta !== 0 && activeCategory !== 'recent') {
      if (prevHeight === 0 && newHeight > 0 && container.scrollTop < 12) {
        container.scrollTop += newHeight
      } else if (container.scrollTop > 12) {
        container.scrollTop = Math.max(0, container.scrollTop + delta)
      }
    }
  }, [recentEmojis, activeCategory, isSearching])

  // Scroll-spy (throttled via rAF, guarded against overwriting programmatic tab jumps)
  useEffect(() => {
    const container = scrollRef.current
    if (!container || isSearching) return

    let rafId = 0
    const clearProgrammaticLock = () => {
      programmaticTargetRef.current = null
    }
    const handleScroll = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        const lock = programmaticTargetRef.current
        if (lock && performance.now() < lock.until) {
          setActiveCategory((prev) => (prev === lock.id ? prev : lock.id))
          return
        }
        programmaticTargetRef.current = null
        const top = container.scrollTop + 24
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
    container.addEventListener('wheel', clearProgrammaticLock, { passive: true })
    container.addEventListener('touchmove', clearProgrammaticLock, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      container.removeEventListener('wheel', clearProgrammaticLock)
      container.removeEventListener('touchmove', clearProgrammaticLock)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [allCategories, isSearching])

  // Synchronously position scroll when leaving search mode (either via category click or clear)
  useLayoutEffect(() => {
    const wasSearching = wasSearchingRef.current
    wasSearchingRef.current = isSearching
    if (isSearching || !wasSearching) return

    const container = scrollRef.current
    if (!container) return
    const targetId = pendingCategoryRef.current ?? activeCategory
    pendingCategoryRef.current = null
    const el = sectionRefs.current.get(targetId)
    if (el) {
      programmaticTargetRef.current = { id: targetId, until: performance.now() + 200 }
      container.scrollTop = targetId === allCategories[0]?.id ? 0 : Math.max(0, el.offsetTop - 2)
    } else {
      container.scrollTop = 0
    }
  }, [isSearching, activeCategory, allCategories])

  // Deduplicated search filter (includes recent + all categories without duplicate keys)
  const filteredEmojis = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return []
    const seen = new Set<string>()
    const results: string[] = []
    for (const cat of EMOJI_CATEGORIES) {
      for (const emoji of cat.emojis) {
        if (seen.has(emoji)) continue
        const kw = EMOJI_KEYWORDS[emoji]
        if (kw?.some((k) => k.includes(q)) || cat.name.toLowerCase().includes(q)) {
          seen.add(emoji)
          results.push(emoji)
        }
      }
    }
    return results
  }, [searchQuery])

  const handleCategoryClick = useCallback(
    (id: string) => {
      setActiveCategory(id)
      programmaticTargetRef.current = { id, until: performance.now() + 200 }
      if (isSearching) {
        pendingCategoryRef.current = id
        setSearchQuery('')
        return
      }
      requestAnimationFrame(() => {
        const el = sectionRefs.current.get(id)
        const container = scrollRef.current
        if (el && container) {
          programmaticTargetRef.current = { id, until: performance.now() + 200 }
          container.scrollTop = id === 'recent' ? 0 : Math.max(0, el.offsetTop - 2)
        }
      })
    },
    [isSearching],
  )

  const handleTabsKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') {
        return
      }
      const tabs = tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      if (!tabs || tabs.length === 0) return
      e.preventDefault()
      const list = Array.from(tabs)
      const currentIdx = list.indexOf(document.activeElement as HTMLButtonElement)
      let nextIdx = 0
      if (e.key === 'Home') {
        nextIdx = 0
      } else if (e.key === 'End') {
        nextIdx = list.length - 1
      } else if (e.key === 'ArrowRight') {
        nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % list.length
      } else if (e.key === 'ArrowLeft') {
        nextIdx = currentIdx <= 0 ? list.length - 1 : currentIdx - 1
      }
      const nextBtn = list[nextIdx]
      if (nextBtn) {
        nextBtn.focus({ preventScroll: true })
        const catId = nextBtn.getAttribute('data-cat-id')
        if (catId) handleCategoryClick(catId)
      }
    },
    [handleCategoryClick],
  )

  const handleClearSearch = useCallback(() => {
    setSearchQuery('')
    searchInputRef.current?.focus({ preventScroll: true })
  }, [])

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
          <span className="emoji-picker__mode-pill active">
            <svg className="emoji-picker__mode-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="M8.5 14.5c.9 1.2 2.1 1.8 3.5 1.8s2.6-.6 3.5-1.8" />
              <circle cx="9" cy="9.5" r="1" fill="currentColor" stroke="none" />
              <circle cx="15" cy="9.5" r="1" fill="currentColor" stroke="none" />
            </svg>
            <span>Эмодзи</span>
          </span>
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
      <div
        className="emoji-picker__search-bar"
        onClick={() => searchInputRef.current?.focus({ preventScroll: true })}
      >
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
          ref={searchInputRef}
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
            onClick={(e) => {
              e.stopPropagation()
              handleClearSearch()
            }}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>

      {/* Category tabs row (9 monochrome vector icons) */}
      <div className="emoji-picker__toolbar">
        <div
          ref={tabsRef}
          className="emoji-picker__tabs"
          role="tablist"
          aria-label="Категории эмодзи"
          onKeyDown={handleTabsKeyDown}
        >
          <button
            type="button"
            role="tab"
            data-cat-id="recent"
            aria-selected={!isSearching && activeCategory === 'recent'}
            className={`emoji-picker__tab${!isSearching && activeCategory === 'recent' ? ' active' : ''}`}
            onClick={() => handleCategoryClick('recent')}
            aria-label="Недавние"
            title="Недавние"
          >
            <CategoryIcon id="recent" />
          </button>
          {EMOJI_CATEGORIES.map((cat) => {
            const isActive = !isSearching && activeCategory === cat.id
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                data-cat-id={cat.id}
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
                      onMouseDown={(e) => e.preventDefault()}
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
                {cat.emojis.length > 0 ? (
                  <div className="emoji-picker__grid">
                    {cat.emojis.map((emoji, idx) => (
                      <button
                        key={`${cat.id}-${emoji}-${idx}`}
                        type="button"
                        className="emoji-btn"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => handleEmojiClick(emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="emoji-picker__recent-empty">
                    Здесь появятся недавно использованные эмодзи
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
