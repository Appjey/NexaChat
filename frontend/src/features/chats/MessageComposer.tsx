import { useEffect, useRef } from 'react'

import type { Message } from '../../shared/api/types'
import { formatFileSize, getFileIcon } from '../../shared/utils'

// Clipboard images (e.g. screenshots) often arrive without a usable filename.
// Synthesize one from the mime type so the attachment shows something sensible
// (the real name is what ends up encrypted in the attachment metadata).
function renameClipboardFile(file: File): File {
  const ext = (file.type.split('/')[1] || 'bin').split(';')[0]
  return new File([file], `pasted-${Date.now()}.${ext}`, { type: file.type || 'application/octet-stream' })
}

type Props = {
  messages: Message[]
  replyToId: number | null
  editingMessageId: number | null
  messageText: string
  selectedFiles: File[]
  uploading: boolean
  sending?: boolean
  showEmojiPanel?: boolean
  /** When true, the input + send button are disabled and styled greyed out.
   *  Used to gate sends behind E2E-readiness: if any recipient hasn't set up
   *  encryption, the composer is blocked until they do. */
  disabled?: boolean
  onMessageTextChange: (text: string) => void
  onSubmit: (event: React.FormEvent) => void
  onFileSelect: (files: File[]) => void
  onRemoveFile: (index: number) => void
  onCancelDraft: () => void
  onToggleEmoji: () => void
}

export function MessageComposer({
  messages,
  replyToId,
  editingMessageId,
  messageText,
  selectedFiles,
  uploading,
  sending,
  showEmojiPanel,
  disabled = false,
  onMessageTextChange,
  onSubmit,
  onFileSelect,
  onRemoveFile,
  onCancelDraft,
  onToggleEmoji,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messageInputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow vertically with content, capped at ~6 lines (200px). On every
  // value change we measure scrollHeight, which forces a layout — fine for a
  // single textarea, not a hot path. Reset to 'auto' first so the textarea
  // can also *shrink* when text is deleted (otherwise it would stay tall).
  const MAX_HEIGHT = 200
  useEffect(() => {
    const el = messageInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [messageText])

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    if (files.length > 0) {
      onFileSelect(files)
    }
  }

  // Paste images/files (Ctrl+V) straight into the composer — pull any "file"
  // items out of the clipboard and attach them. preventDefault only when we
  // actually consumed files, so pasting plain text still works normally.
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || uploading) return
    const items = event.clipboardData?.items
    if (!items) return
    const pasted: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) pasted.push(file.name ? file : renameClipboardFile(file))
    }
    if (pasted.length > 0) {
      event.preventDefault()
      onFileSelect(pasted)
    }
  }

  const replyToMessage = replyToId ? messages.find((m) => m.id === replyToId) : null
  // Attachment-only messages have empty text — show a marker so the reply
  // banner isn't blank.
  const replyPreviewText = replyToMessage
    ? replyToMessage.text?.trim()
      ? replyToMessage.text.trim().slice(0, 50)
      : replyToMessage.attachments?.length
        ? '📎 Вложение'
        : ''
    : ''

  return (
    <form id="chat-form" className="chat-composer" onSubmit={onSubmit}>
      {(replyToId || editingMessageId) && (
        <div className="reply-preview-container">
          <span>
            {editingMessageId
              ? 'Редактирование сообщения'
              : `Ответ на: ${replyPreviewText}`}
          </span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={onCancelDraft}>
            Отмена
          </button>
        </div>
      )}

      {selectedFiles.length > 0 && (
        <div className="attachments-preview">
          {selectedFiles.map((file, index) => (
            <div key={`${file.name}-${index}`} className="attachment-preview-pill">
              <span className="attachment-preview-icon">{getFileIcon(file)}</span>
              <div className="attachment-preview-meta">
                <span className="attachment-preview-name">{file.name}</span>
                <span className="attachment-preview-size">{formatFileSize(file.size)}</span>
              </div>
              <button type="button" className="btn icon-btn remove-attachment" onClick={() => onRemoveFile(index)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-composer__controls">
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          multiple
          onChange={handleFileChange}
        />
        <button
          type="button"
          className="btn icon-btn attach-btn"
          title="Прикрепить файл"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || disabled}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          id="message"
          ref={messageInputRef}
          className="form-control composer-input"
          placeholder="Напишите сообщение..."
          rows={1}
          value={messageText}
          onChange={(e) => onMessageTextChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline (default textarea behavior).
            // Skip the send shortcut on mobile Android Capacitor WebView where
            // physical keyboards aren't the norm and IME composition uses Enter.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing &&
                (messageText.trim() || selectedFiles.length > 0)) {
              e.preventDefault()
              onSubmit(e as unknown as React.FormEvent)
            }
          }}
          disabled={uploading || disabled}
          style={{ resize: 'none', overflowY: 'auto', maxHeight: MAX_HEIGHT, minHeight: 38, lineHeight: '1.4' }}
        />
        <div className="composer-right">
          <button
            type="button"
            className={`btn icon-btn emoji-toggle-large${showEmojiPanel ? ' emoji-toggle-active' : ''}`}
            title="Смайлики"
            onClick={onToggleEmoji}
            disabled={uploading || disabled}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth="3" strokeLinecap="round" />
              <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="submit"
            // Prevent the button from stealing focus on tap — keeps the Android soft keyboard open
            // after send (browser default on mousedown is to shift focus to the button).
            onMouseDown={(e) => e.preventDefault()}
            className={`btn icon-btn send-btn${sending ? ' send-btn--sending' : ''}`}
            title="Отправить"
            aria-label="Отправить"
            disabled={uploading || disabled || sending || (!messageText.trim() && selectedFiles.length === 0)}
          >
            {sending ? (
              <span className="send-spinner" />
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            )}
          </button>
        </div>
      </div>
      <div className="chat-composer__hint" aria-hidden="true">
        <span>Enter — отправить</span>
        <span>Shift + Enter — новая строка</span>
      </div>
    </form>
  )
}
