import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { endpoints } from '../../shared/api/endpoints'
import { httpGet } from '../../shared/api/httpClient'
import type { Attachment, Message, UserProfile } from '../../shared/api/types'
import { ConfirmDialog } from '../../shared/components/ConfirmDialog'
import { CheckIcon, DoubleCheckIcon } from '../../shared/components/Icons'
import { useToast } from '../../shared/components/ToastContext'
import { decryptFile, decryptMetadata, unwrapFileKey } from '../../shared/crypto/e2e'
import { getChatKey } from '../../shared/crypto/peerKeys'
import { downloadAttachmentNative } from '../../shared/downloadAttachment'
import { log } from '../../shared/log'
import { isNative } from '../../shared/platform'
import { formatFileSize, formatMessageTime, linkify } from '../../shared/utils'
import { useAccountKey } from '../auth/AccountKey'
import { ImageLightbox } from './ImageLightbox'

// Module-level cache of resolved display names for forwarded-message authors.
// A forwarded original can come from a chat/user not present in the current
// chat (the whole point of forwarding), so member maps can't always resolve it.
// We fetch the profile lazily and memoise by id across all message bubbles.
const forwardedNameCache = new Map<number, string>()

function useForwardedFromName(userId: number | null, isSelf: boolean): string | null {
  const [name, setName] = useState<string | null>(() =>
    userId ? forwardedNameCache.get(userId) ?? null : null,
  )
  useEffect(() => {
    if (!userId || isSelf) return
    let cancelled = false
    const resolve = async () => {
      const cached = forwardedNameCache.get(userId)
      if (cached) {
        if (!cancelled) setName(cached)
        return
      }
      try {
        const p = await httpGet<UserProfile>(endpoints.profile(userId))
        const resolved = p.name || p.username || `User #${userId}`
        forwardedNameCache.set(userId, resolved)
        if (!cancelled) setName(resolved)
      } catch { /* leave null → generic placeholder in the label */ }
    }
    void resolve()
    return () => { cancelled = true }
  }, [userId, isSelf])
  return name
}

// Detect messages containing only 1–3 emojis (sticker-style)
const EMOJI_REGEX = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F){1,3}$/u
function isEmojiOnly(text: string): boolean {
  return EMOJI_REGEX.test(text.trim())
}

type Props = {
  message: Message
  isOwn: boolean
  senderName: string
  showSenderName?: boolean
  senderColor?: string
  currentUserId?: number
  // Read-receipt state for our own 1-on-1 messages (undefined = no tick shown).
  receiptStatus?: 'sent' | 'delivered' | 'read'
  replyToMessage?: Message | null
  isPinned?: boolean
  canPin?: boolean
  onReply: (msgId: number) => void
  onEdit: (msgId: number, text: string) => void
  onDelete: (msgId: number) => void
  onForward: (msgId: number) => void
  onPin?: (msgId: number) => void
  onUnpin?: (msgId: number) => void
  /** Scroll to a message — used when the reply-quote is tapped. */
  onJumpToMessage?: (msgId: number) => void
}

type ContextMenuState = {
  visible: boolean
  x: number
  y: number
}

// Only one message context menu may be open app-wide. Each MessageItem owns its
// own `contextMenu` state, and the close-on-outside handler only fires on a left
// `click` — so right-clicking a *second* bubble (a `contextmenu` event, not a
// `click`) would leave the first menu open, stacking menus. This module-level
// closer points at whichever menu is currently open; opening a new one closes the
// previous via this handle first.
let activeContextMenuCloser: (() => void) | null = null

type AttachmentViewProps = {
  att: Attachment
  senderUserId: number
  onImageClick: (src: string, alt: string) => void
}

// Derive the UI render bucket (image / video / document) from a mime type.
// Used to live server-side as `determineFileType`; moved client-side because
// the server no longer sees the real mime (it's encrypted under file_key
// alongside the body).
function bucketFromMime(mime: string): 'image' | 'video' | 'document' {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'document'
}

/**
 * Renders one attachment. Every attachment is E2E: fetch the ciphertext blob,
 * unwrap the file_key, decrypt both the small metadata blob (filename + mime)
 * and the body, render via blob URL. Rows missing any E2E field
 * (encrypted_file_key, envelope_iv, file_iv, encrypted_metadata, metadata_iv)
 * are treated as broken and surface the "🔒 Не удалось расшифровать"
 * placeholder — legacy plaintext attachments don't exist after the metadata
 * migration.
 */
function AttachmentView({ att, senderUserId, onImageClick }: AttachmentViewProps) {
  const accountKeyCtx = useAccountKey()
  const { showToast } = useToast()
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [decryptedBlob, setDecryptedBlob] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  // True while the download-confirmation modal is on screen.
  const [confirmOpen, setConfirmOpen] = useState(false)
  // True while the native save+share chain is running — disables modal
  // buttons so we don't fire two downloads on a double-tap.
  const [downloading, setDownloading] = useState(false)
  // Decrypted filename + mime — empty until decrypt completes.
  const [decryptedMeta, setDecryptedMeta] = useState<{ fileName: string; mimeType: string } | null>(null)

  const hasAllE2EFields = Boolean(
    att.encrypted_file_key &&
      att.envelope_iv &&
      att.file_iv &&
      att.encrypted_metadata &&
      att.metadata_iv,
  )

  useEffect(() => {
    if (!hasAllE2EFields) return
    if (accountKeyCtx.state.status !== 'ready') return
    if (!att.url) return

    let cancelled = false
    let currentUrl: string | null = null

    const run = async () => {
      try {
        const accountKey = accountKeyCtx.state.status === 'ready' ? accountKeyCtx.state.key : null
        if (!accountKey) throw new Error('account_key missing')
        const chatKey = await getChatKey(accountKey, senderUserId)
        if (!chatKey) throw new Error('cannot derive chat_key for sender')
        const fileKey = await unwrapFileKey(att.encrypted_file_key as string, att.envelope_iv as string, chatKey)

        // Decrypt the metadata blob FIRST so we know the real mime to pass
        // to the Blob constructor (browser sniffs bytes anyway for <img>,
        // but a correct type matters for <video>/download).
        const meta = await decryptMetadata(att.encrypted_metadata as string, att.metadata_iv as string, fileKey)
        if (cancelled) return
        const mime = meta.mimeType || 'application/octet-stream'
        setDecryptedMeta({ fileName: meta.fileName, mimeType: mime })

        const ctRes = await fetch(att.url as string)
        if (!ctRes.ok) throw new Error(`fetch ${ctRes.status}`)
        const ctBuf = new Uint8Array(await ctRes.arrayBuffer())
        const decrypted = await decryptFile(ctBuf, att.file_iv as string, fileKey, mime)
        if (cancelled) return
        currentUrl = URL.createObjectURL(decrypted)
        setBlobUrl(currentUrl)
        // Keep the raw Blob too — native download path needs the bytes
        // (can't read them back from blob: URL through the Capacitor
        // WebView's restricted fetch on a fresh tab).
        setDecryptedBlob(decrypted)
      } catch (err) {
        if (!cancelled) {
          log.warn('attachment decrypt failed:', err)
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    run()

    return () => {
      cancelled = true
      if (currentUrl) URL.revokeObjectURL(currentUrl)
    }
  }, [
    hasAllE2EFields,
    accountKeyCtx.state,
    senderUserId,
    att.url,
    att.encrypted_file_key,
    att.envelope_iv,
    att.file_iv,
    att.encrypted_metadata,
    att.metadata_iv,
  ])

  if (!att.id || !att.url) return null

  // Rows missing any of the five required E2E fields are unrenderable.
  // After the legacy metadata removal, every valid attachment must have
  // all of them — show a clear "not decryptable" placeholder instead of
  // silently rendering a broken file.
  if (!hasAllE2EFields) {
    return <div className="attachment-document attachment-error">🔒 Не удалось расшифровать вложение</div>
  }
  if (error) {
    return <div className="attachment-document attachment-error">🔒 Не удалось расшифровать вложение</div>
  }
  if (!blobUrl) {
    return <div className="attachment-document attachment-loading">🔒 Расшифровка…</div>
  }

  const fileName = decryptedMeta?.fileName || 'Файл'
  const mimeType = decryptedMeta?.mimeType || 'application/octet-stream'
  const bucket = bucketFromMime(mimeType)

  // The chat-bubble document plate always opens a confirmation modal first:
  // browsers fire `<a download>` instantly with no chance to cancel, and on
  // native we'd silently start writing to disk. The modal gives the user a
  // clear "Скачать file.pdf?" prompt before either path runs.
  const handleDocClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    if (!blobUrl) return
    setConfirmOpen(true)
  }

  // Confirm-flow: dispatch to the native helper or trigger a synthetic
  // browser download. Either way, close the modal when we're done.
  const handleConfirmDownload = () => {
    if (downloading || !blobUrl) return

    if (isNative()) {
      if (!decryptedBlob) {
        showToast('Файл ещё расшифровывается', 'warning')
        return
      }
      setDownloading(true)
      void downloadAttachmentNative(decryptedBlob, fileName, mimeType).then((res) => {
        setDownloading(false)
        setConfirmOpen(false)
        if (res.ok && (res.savedTo === 'download' || res.savedTo === 'documents')) {
          showToast(`Сохранено: ${res.humanPath}`, 'success')
        } else if (!res.ok) {
          showToast('Не удалось скачать файл', 'error')
          log.warn('native download failed:', res.error)
        }
        // savedTo === 'shared' → system share sheet already gave feedback.
      })
      return
    }

    // Web: synthesise an anchor click so the browser's download manager
    // takes over (the visible <a> already has href/download, but it can't
    // be the source of the click because we preventDefault'd it above).
    const a = document.createElement('a')
    a.href = blobUrl
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setConfirmOpen(false)
  }

  if (bucket === 'image') {
    return (
      <button
        type="button"
        className="attachment-image-btn"
        onClick={() => onImageClick(blobUrl, fileName)}
      >
        <img src={blobUrl} alt={fileName} loading="lazy" />
      </button>
    )
  }

  if (bucket === 'video') {
    return (
      <video controls>
        <source src={blobUrl} type={mimeType} />
      </video>
    )
  }

  return (
    <>
      <a href={blobUrl} download={fileName} className="attachment-document" onClick={handleDocClick}>
        <span className="attachment-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </span>
        <div className="attachment-info">
          <span className="attachment-name">{fileName}</span>
          <span className="attachment-size">{formatFileSize(att.file_size)}</span>
        </div>
      </a>
      <ConfirmDialog
        isOpen={confirmOpen}
        title="Скачать файл?"
        message={`${fileName} (${formatFileSize(att.file_size)})`}
        confirmLabel="Скачать"
        cancelLabel="Отмена"
        busy={downloading}
        onConfirm={handleConfirmDownload}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  )
}

function MessageItemInner({
  message,
  isOwn,
  senderName,
  showSenderName = false,
  senderColor,
  currentUserId,
  receiptStatus,
  replyToMessage,
  isPinned,
  canPin,
  onReply,
  onEdit,
  onDelete,
  onForward,
  onPin,
  onUnpin,
  onJumpToMessage,
}: Props) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
  })
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null)

  const handleImageClick = useCallback((src: string, alt: string) => {
    setLightboxImage({ src, alt })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }))
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (message.is_deleted) return
    e.preventDefault()
    // A contextmenu event on another bubble doesn't fire the open menu's
    // click-outside listener, so close whatever menu is still open before we
    // claim the single app-wide open slot — otherwise menus stack up.
    if (activeContextMenuCloser && activeContextMenuCloser !== closeContextMenu) {
      activeContextMenuCloser()
    }
    activeContextMenuCloser = closeContextMenu
    // Open at the cursor; the layout effect below clamps to the viewport once
    // the menu's real size is known (it varies with the visible item set).
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY })
  }, [message.is_deleted, closeContextMenu])

  // Keep the menu fully on-screen. Measured after render (before paint, so no
  // flicker) because the menu width/height depend on which items show — the
  // old hardcoded 150×200 estimate let wide/tall menus overflow.
  const menuRef = useRef<HTMLDivElement>(null)
  const didAutoFocusMenuRef = useRef(false)
  useLayoutEffect(() => {
    if (!contextMenu.visible) {
      didAutoFocusMenuRef.current = false
      return
    }
    const el = menuRef.current
    if (!el) return
    const padding = 12
    const rect = el.getBoundingClientRect()
    const width = Math.max(el.offsetWidth, rect.width)
    const height = Math.max(el.offsetHeight, rect.height)
    const viewportW = window.visualViewport?.width ?? window.innerWidth
    const viewportH = window.visualViewport?.height ?? window.innerHeight
    const maxX = Math.max(padding, viewportW - width - padding)
    const maxY = Math.max(padding, viewportH - height - padding)
    const x = Math.max(padding, Math.min(contextMenu.x, maxX))
    const y = Math.max(padding, Math.min(contextMenu.y, maxY))
    if (x !== contextMenu.x || y !== contextMenu.y) {
      setContextMenu((prev) => ({ ...prev, x, y }))
    }
    if (!didAutoFocusMenuRef.current) {
      didAutoFocusMenuRef.current = true
      const firstItem = el.querySelector<HTMLButtonElement>('[role="menuitem"]')
      firstItem?.focus({ preventScroll: true })
    }
  }, [contextMenu.visible, contextMenu.x, contextMenu.y])

  const focusComposerInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = document.getElementById('message') as HTMLTextAreaElement | null
      if (input && !input.disabled) {
        input.focus({ preventScroll: true })
        const len = input.value.length
        input.setSelectionRange(len, len)
      }
    })
  }, [])

  const handleReply = useCallback(() => {
    onReply(message.id)
    closeContextMenu()
    focusComposerInput()
  }, [message.id, onReply, closeContextMenu, focusComposerInput])

  const handleEdit = useCallback(() => {
    onEdit(message.id, message.text)
    closeContextMenu()
    focusComposerInput()
  }, [message.id, message.text, onEdit, closeContextMenu, focusComposerInput])

  const handleDelete = useCallback(() => {
    onDelete(message.id)
    closeContextMenu()
  }, [message.id, onDelete, closeContextMenu])

  const copyableText = message.text.trim()
  const canEditMessage = isOwn && message.scheme === 2

  const handleCopyText = useCallback(() => {
    if (copyableText) {
      void navigator.clipboard?.writeText(copyableText)
    }
    closeContextMenu()
  }, [copyableText, closeContextMenu])

  const handleForward = useCallback(() => {
    onForward(message.id)
    closeContextMenu()
  }, [message.id, onForward, closeContextMenu])

  const handlePin = useCallback(() => {
    onPin?.(message.id)
    closeContextMenu()
  }, [message.id, onPin, closeContextMenu])

  const handleUnpin = useCallback(() => {
    onUnpin?.(message.id)
    closeContextMenu()
  }, [message.id, onUnpin, closeContextMenu])

  const moveMenuFocus = useCallback((key: string) => {
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    if (!items || items.length === 0) return
    const list = Array.from(items)
    const currentIndex = list.indexOf(document.activeElement as HTMLButtonElement)
    let nextIndex = 0
    if (key === 'Home') {
      nextIndex = 0
    } else if (key === 'End') {
      nextIndex = list.length - 1
    } else if (key === 'ArrowDown') {
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % list.length
    } else if (key === 'ArrowUp') {
      nextIndex = currentIndex <= 0 ? list.length - 1 : currentIndex - 1
    }
    list[nextIndex]?.focus({ preventScroll: true })
  }, [])

  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeContextMenu()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        e.stopPropagation()
        moveMenuFocus(e.key)
      }
    },
    [closeContextMenu, moveMenuFocus],
  )

  // Close context menu on click outside, scroll, resize, or Escape, and allow
  // arrow-key navigation even if focus hasn't entered the menu yet.
  useEffect(() => {
    if (!contextMenu.visible) return

    const handleClickOutside = () => closeContextMenu()
    const handleScroll = () => closeContextMenu()
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeContextMenu()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        if (!menuRef.current?.contains(document.activeElement)) {
          e.preventDefault()
          moveMenuFocus(e.key)
        }
      }
    }

    document.addEventListener('click', handleClickOutside)
    document.addEventListener('scroll', handleScroll, true)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleClickOutside)

    return () => {
      document.removeEventListener('click', handleClickOutside)
      document.removeEventListener('scroll', handleScroll, true)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleClickOutside)
      // Release the single open slot if we still own it (don't clobber a menu
      // another bubble just opened — it has already reclaimed the slot).
      if (activeContextMenuCloser === closeContextMenu) {
        activeContextMenuCloser = null
      }
    }
  }, [contextMenu.visible, closeContextMenu, moveMenuFocus])

  const emojiOnly = !message.is_deleted && isEmojiOnly(message.text)

  // The WS broadcast carries 0 (not null) for non-forwarded messages — the same
  // "none" sentinel reply_to_id uses — so treat any non-positive value as
  // "not forwarded". `?? null` / `!= null` would wrongly accept 0.
  const forwardedFromId = message.forwarded_from_user_id && message.forwarded_from_user_id > 0
    ? message.forwarded_from_user_id
    : null
  const isForwardedFromSelf = forwardedFromId !== null && forwardedFromId === currentUserId
  const forwardedFromName = useForwardedFromName(forwardedFromId, isForwardedFromSelf)

  return (
    <>
      <div
        id={`msg-${message.id}`}
        className={`message ${isOwn ? 'message-self' : 'message-other'}${message.is_deleted ? ' deleted' : ''}${emojiOnly ? ' message--emoji-only' : ''}`}
        data-msg-id={message.id}
        data-user-id={message.user_id}
        onContextMenu={handleContextMenu}
      >
        {isPinned && (
          <div className="message-pin-indicator" title="Закреплено" aria-label="Закреплено">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
            </svg>
            <span>Закреплено</span>
          </div>
        )}
        {forwardedFromId != null && !message.is_deleted && (
          <div className="forwarded-label">
            ↪ Переслано от{' '}
            <span className="forwarded-from-name">
              {isForwardedFromSelf ? 'вас' : (forwardedFromName || 'пользователя')}
            </span>
          </div>
        )}
        {replyToMessage && (
          <div
            className="reply-preview"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onJumpToMessage?.(replyToMessage.id)
            }}
          >
            <span className="reply-tag">↩</span>{' '}
            {replyToMessage.is_deleted ? (
              <i>Сообщение удалено</i>
            ) : replyToMessage.text.trim() ? (
              replyToMessage.text.trim().substring(0, 64)
            ) : replyToMessage.attachments && replyToMessage.attachments.length > 0 ? (
              '📎 Вложение'
            ) : (
              '[Пустое сообщение]'
            )}
          </div>
        )}

        {showSenderName && forwardedFromId === null && (
          <div className="message__header">
            <span className="message-sender" style={senderColor ? { color: senderColor } : undefined}>{senderName}</span>
          </div>
        )}

        <div className="message__content">
          {message.is_deleted ? (
            <span className="message-text text-muted">
              <i>Сообщение удалено</i>
            </span>
          ) : (
            <>
              {(message.text.trim() || !(message.attachments && message.attachments.length > 0)) && (
                <span className={`message-text${emojiOnly ? ' message-text--emoji-only' : ''}`}>
                  {message.text.trim() ? linkify(message.text.trim()) : '[Пустое сообщение]'}
                  {message.edited_at && <span className="edited-indicator"> (ред.)</span>}
                </span>
              )}

              {message.attachments && message.attachments.length > 0 && (
                <div className="message-attachments">
                  {message.attachments
                    .filter((att) => att.id)
                    .map((att) => (
                      <div key={att.id} className="attachment-item">
                        <AttachmentView
                          att={att}
                          senderUserId={message.user_id}
                          onImageClick={handleImageClick}
                        />
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="message__meta">
          <span className="message-time">{formatMessageTime(message.created_at)}</span>
          {receiptStatus && (
            <span
              className={`message-receipt message-receipt--${receiptStatus}`}
              aria-label={receiptStatus === 'read' ? 'Прочитано' : receiptStatus === 'delivered' ? 'Доставлено' : 'Отправлено'}
            >
              {receiptStatus === 'sent' ? <CheckIcon size={14} /> : <DoubleCheckIcon size={15} />}
            </span>
          )}
        </div>
      </div>

      {contextMenu.visible && (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          aria-label="Действия с сообщением"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
        >
          <button type="button" role="menuitem" className="context-menu-item" onClick={handleReply}>
            <svg className="context-menu-item__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
            <span>Ответить</span>
          </button>
          <button type="button" role="menuitem" className="context-menu-item" onClick={handleForward}>
            <svg className="context-menu-item__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 17 20 12 15 7" />
              <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
            </svg>
            <span>Переслать</span>
          </button>
          {Boolean(copyableText) && (
            <button type="button" role="menuitem" className="context-menu-item" onClick={handleCopyText}>
              <svg className="context-menu-item__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>Копировать</span>
              <span className="context-menu-item__shortcut" aria-hidden="true">⌘C</span>
            </button>
          )}
          {canPin && !isPinned && (
            <button type="button" role="menuitem" className="context-menu-item" onClick={handlePin}>
              <svg className="context-menu-item__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
              </svg>
              <span>Закрепить</span>
            </button>
          )}
          {canPin && isPinned && (
            <button type="button" role="menuitem" className="context-menu-item" onClick={handleUnpin}>
              <svg className="context-menu-item__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="2" y1="2" x2="22" y2="22" />
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h12" />
                <path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89" />
              </svg>
              <span>Открепить</span>
            </button>
          )}
          {isOwn && (
            <>
              {canEditMessage && (
                <button type="button" role="menuitem" className="context-menu-item" onClick={handleEdit}>
                  <svg className="context-menu-item__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                  <span>Редактировать</span>
                </button>
              )}
              <div className="context-menu-divider" role="separator" />
              <button type="button" role="menuitem" className="context-menu-item danger" onClick={handleDelete}>
                <svg className="context-menu-item__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
                <span>Удалить</span>
              </button>
            </>
          )}
        </div>
      )}

      {lightboxImage && (
        <ImageLightbox
          src={lightboxImage.src}
          alt={lightboxImage.alt}
          onClose={() => setLightboxImage(null)}
        />
      )}
    </>
  )
}

// Memoised export — a chat with 500+ messages re-renders every bubble on every parent
// state update (presence tick, new incoming message, etc.). With stable callbacks from
// ChatWindow, the default shallow prop compare lets React skip N-1 renders.
export const MessageItem = memo(MessageItemInner)
