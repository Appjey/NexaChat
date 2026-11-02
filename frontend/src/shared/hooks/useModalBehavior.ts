import { type RefObject, useEffect, useRef } from 'react'

type UseModalBehaviorOptions = {
  isOpen: boolean
  onClose: () => void
  containerRef?: RefObject<HTMLElement | null>
  trapFocus?: boolean
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useModalBehavior({
  isOpen,
  onClose,
  containerRef,
  trapFocus = false,
}: UseModalBehaviorOptions) {
  const previousActiveElementRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!isOpen) return

    if (trapFocus && document.activeElement instanceof HTMLElement) {
      previousActiveElementRef.current = document.activeElement
    }

    const container = containerRef?.current
    if (trapFocus && container) {
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      )
      if (focusable.length > 0 && !container.contains(document.activeElement)) {
        focusable[0].focus()
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }

      if (trapFocus && e.key === 'Tab' && containerRef?.current) {
        const focusable = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        )
        if (focusable.length === 0) return

        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (
            document.activeElement === first ||
            !containerRef.current.contains(document.activeElement)
          ) {
            e.preventDefault()
            last.focus()
          }
        } else if (
          document.activeElement === last ||
          !containerRef.current.contains(document.activeElement)
        ) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      if (trapFocus && previousActiveElementRef.current) {
        const prev = previousActiveElementRef.current
        previousActiveElementRef.current = null
        if (document.body.contains(prev)) {
          prev.focus()
        }
      }
    }
  }, [isOpen, containerRef, trapFocus])

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return { handleBackdropClick }
}
