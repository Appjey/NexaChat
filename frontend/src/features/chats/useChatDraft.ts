import { useCallback, useEffect, useRef } from 'react'

const draftKey = (chatId: number) => `chat_draft_${chatId}`

/**
 * Per-chat composer draft persistence (localStorage).
 *
 * The write side is proactive rather than cleanup-driven: on mobile
 * (Capacitor WebView) the user typically backgrounds or kills the app without
 * switching chats, so a cleanup-time save would never fire. We therefore save
 * on every keystroke (debounced) and flush synchronously on pagehide /
 * visibilitychange, and ChatWindow additionally saves the old chat's draft
 * when switching (via `persistDraft` + `messageTextRef`).
 */
export function useChatDraft({
  chatId,
  draftReloadKey,
  messageText,
  setMessageText,
}: {
  chatId?: number
  // Bumped by the parent to re-read the draft without a chat switch (content
  // shared into the chat that is already open).
  draftReloadKey: number
  messageText: string
  setMessageText: (text: string) => void
}) {
  // Mirror of messageText for cleanup-time saves (closures otherwise see the
  // value at effect-run time, not the latest user input).
  const messageTextRef = useRef(messageText)
  useEffect(() => { messageTextRef.current = messageText }, [messageText])

  const persistDraft = useCallback((cid: number, text: string) => {
    try {
      if (text) localStorage.setItem(draftKey(cid), text)
      else localStorage.removeItem(draftKey(cid))
    } catch { /* quota / private mode */ }
  }, [])

  const readDraft = useCallback((cid: number): string => {
    try { return localStorage.getItem(draftKey(cid)) ?? '' } catch { return '' }
  }, [])

  const clearDraft = useCallback((cid: number) => {
    try { localStorage.removeItem(draftKey(cid)) } catch { /* ignore */ }
  }, [])

  // On-demand re-read. No cleanup here, so it never overwrites a freshly
  // written draft.
  useEffect(() => {
    if (!chatId || draftReloadKey === 0) return
    setMessageText(readDraft(chatId))
  }, [draftReloadKey, chatId, readDraft, setMessageText])

  // Debounced save on every keystroke. 400 ms: small enough that
  // "type → swipe to background" rarely loses anything, large enough not to
  // hit localStorage per character.
  useEffect(() => {
    if (!chatId) return
    const t = setTimeout(() => persistDraft(chatId, messageText), 400)
    return () => clearTimeout(t)
  }, [chatId, messageText, persistDraft])

  // Mobile + tab-close belt: flush synchronously when the page is about to
  // disappear. visibilitychange fires when Android backgrounds the app;
  // pagehide on web tab close / navigation away.
  useEffect(() => {
    if (!chatId) return
    const flush = () => persistDraft(chatId, messageTextRef.current)
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [chatId, persistDraft])

  /** Latest composer text, for cleanup-time saves (refs are not visible to effect deps). */
  const currentText = useCallback(() => messageTextRef.current, [])

  return { readDraft, clearDraft, persistDraft, currentText }
}
