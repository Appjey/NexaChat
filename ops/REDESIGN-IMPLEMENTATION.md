# NexaChat Responsive Redesign Implementation (`v4 — Clear Contrast`)

## Executive Summary

Implemented the NexaChat responsive redesign ("Clear contrast" v4) end-to-end across the React / TypeScript / Vite / Capacitor / Electron frontend (`frontend/`) for [Appjey/NexaChat#1](https://github.com/Appjey/NexaChat/issues/1), following `design/rebrand/TICKET.md`, `design/rebrand/REVIEW.md`, and the approved v4 PNG previews under `design/rebrand/previews/`.

All existing backend API/WS contracts, authentication tokens/cookies, X25519/HKDF/AES-GCM end-to-end encryption, vault bootstrap/recovery, TOFU key pinning, group pairwise envelopes, encrypted attachment metadata, drafts, read receipts, replies/edits/pins/forwards, WebRTC audio calls, and native/desktop origins (`com.messenger.app`, `https://localhost`) are preserved intact.

---

## Key Architectural & Visual Changes

### 1. Theme Tokens & Typography (`Midnight v4` Dark + `Daylight v4` Light)
- **Dark theme (`[data-theme="dark"]` / `:root`)**:
  - Primary canvas `#0D1017`, secondary surface `#141923`, elevated/incoming bubble surface `#191D28`, hover `#1F2533`, selected chat `#352A53`.
  - Primary text `#F2F4FA`, secondary `#A2ABC0`, muted `#6E7891`.
  - Action accent `#7C5CFF` (hover `#8D70FF`), outgoing bubble `#493B67` with `#F5F2FF` text and `#CFC5E8` meta.
- **Light theme (`[data-theme="light"]`)**:
  - Primary canvas `#F0F3F8`, white `#FFFFFF` surfaces, subtle `#F6F8FC` elevated inputs, hover `#EDF1F7`, selected `#ECE6FF`.
  - Primary text `#151A26`, secondary `#5B6478`, muted `#8791A7`.
  - Action accent `#6D4AFF`, outgoing bubble `#E6DCFA` with `#231942` text.
- **Typography**:
  - Added `Manrope` (`--font-display`) and `Inter` (`--font-sans`) with clean system fallbacks (`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `Roboto`, `sans-serif`) and `JetBrains Mono` (`--font-mono`) so the app renders cleanly even when external fonts are blocked or offline.
- **Brand & Icons**:
  - Updated `frontend/index.html`, `frontend/public/manifest.json`, `frontend/public/favicon.svg`, `frontend/public/img/default-avatar.svg`, and `frontend/electron/main.js` (`backgroundColor: '#0D1017'`).

### 2. Colorful Moderate Avatars (`Avatar.tsx`)
- Created `frontend/src/shared/components/Avatar.tsx` providing deterministic moderate avatar colors (`#C46D8E`, `#5386B6`, `#B07D48`, `#438D7D`, `#7E65B8`, `#587BB4`, `#7C66DC`, `#4D8B9C`) with Cyrillic/Latin initials fallback when no custom photo is uploaded, `И` on `#7C66DC` for `Избранное`, and graceful image `onError` fallback.
- Integrated `Avatar` across `ChatList`, `ChatWindow`, `SlideMenu`, `ContactsModal`, `CreateGroupModal`, `AddMembersModal`, `GroupInfoPanel`, `ForwardModal`, `ProfileModal`, `UserProfileModal`, `ProfilePage`, `ActiveCallOverlay`, and `IncomingCallModal`.

### 3. Desktop Two-Column Layout & Navigation Drawer (`SlideMenu.tsx`, `layout.css`, `menu.css`)
- **Two-column desktop shell (`>= 768px`)**: `364px` (or `320px` on `768px–1023px`) chat list column + fluid conversation column (`1fr`) without a permanent leftmost icon rail.
- **Navigation Drawer (`SlideMenu.tsx`)**:
  - Opens from the Hamburger button (`332px` desktop / `320px` mobile) over a scrim (`rgba(13, 16, 23, 0.72)` dark / `rgba(15, 23, 42, 0.44)` light).
  - Header with `NexaChat` wordmark, `×` close button (`32×32`), user avatar (`48×48`), display name, and `@username`.
  - Menu items: `Мой профиль`, `Чаты` (active highlight), `Новый групповой чат`, `Контакты`, divider, `Настройки`, `Тёмная тема` inline switch, divider, and danger `Выйти` (closes drawer before opening confirmation modal so focus traps never compete), plus footer (`NexaChat` / `На одной волне.`).
  - Accessibility: closed drawer sets `inert`, `aria-hidden={!isOpen}`, and `visibility: hidden` so off-canvas controls cannot be focused by keyboard; open drawer traps focus (`Tab`/`Shift+Tab`), closes on `Escape` or scrim click, and restores focus to the trigger on close (`useModalBehavior.ts`).

### 4. Mobile Layout, Floating New Chat Button & Dialog Back Button (`ChatsPage.tsx`, `ChatWindow.tsx`, `layout.css`, `chat.css`)
- **Mobile Floating New Chat Button (`< 768px`)**:
  - Rendered as a `56×56` (`border-radius: 28px`, `#7C5CFF`, `var(--shadow-lg)`) floating overlay button (`.telegram-mobile-fab`) inside `.telegram-sidebar` as a separate sibling **outside** `.telegram-sidebar__content` (`bottom: calc(64px + env(safe-area-inset-bottom, 0px) + 16px); right: 20px; z-index: 20`).
  - Chat list items scroll underneath with `padding-bottom: calc(92px + env(safe-area-inset-bottom, 0px))` reserved so the final chat row is never obscured.
  - Covered by the drawer scrim (`z-index: 1099`) and marked `disabled` / `tabIndex={-1}` when `menuOpen` is `true`.
- **Mobile Bottom Navigation (`< 768px`)**:
  - Rendered on the mobile chat list view only (`Чаты`, `Контакты`, `Настройки`), hidden inside an active mobile dialog.
- **Mobile Dialog Header & Back Button**:
  - Dedicated `48×48` `.back-btn` hit target (`border-radius: 14px`, `28×28` chevron SVG) with a `12px` flex gap (`16px` visual gap to the avatar) from `.chat-header__link`, calling `e.stopPropagation()`, flushing the current draft immediately via `persistDraft(chatId, currentText())`, and returning to the chat list while preserving the selected chat highlight (`lastSelectedChatId`).
  - On mobile (`< 768px`), in-chat search is accessed via the `⋮` overflow menu so the peer name (`Мария Соколова`) remains readable without premature truncation alongside the audio call and overflow buttons.

### 5. Compact Message Bubbles, Round Composer & Cold Deep-Link Decryption (`MessageList.tsx`, `MessageItem.tsx`, `MessageComposer.tsx`, `threadCrypto.ts`, `ChatsPage.tsx`)
- **Compact Message Bubbles**:
  - Capped desktop bubble width at `min(66%, 460px)` with `width: fit-content` (`82%` max-width on mobile).
  - Hid redundant sender labels (`Вы` / peer name) in 1:1 and self-chats while preserving colored member names in group chats (`showSenderName={isGroup && !isOwn}`).
  - Compact bottom-right `.message__meta` with timestamp and read-receipt ticks (`✓` / `✓✓`).
  - Centered `🔒 Сквозное шифрование` pill and structured E2E key-changed warning card (`Принять новый ключ` / `Сверить код`).
- **Round Composer**:
  - Pill control container (`border-radius: 999px`) with attachment button, emoji button, auto-resizing textarea, `40×40` circular `#7C5CFF` send button, and desktop `Enter — отправить · Shift + Enter — новая строка` hint.
- **Cold Deep-Link (`/?chat=N`) E2E Lifecycle Fix**:
  - Seeded `chatsRef.current` as soon as `getCurrentUserChats()` resolves (before sidebar preview decryptions finish), gated message cache persistence via `canDecryptThread(raw, chatMeta, accountKey)` so unhydrated runs never cache `[зашифрованное сообщение]` placeholders, and re-triggered `loadMessages`/`loadPinned` once `activeChatDecryptKey` and `accountKeyReady` hydrate.

---

## Modified & Added Files

- `frontend/index.html`
- `frontend/public/manifest.json`
- `frontend/public/favicon.svg`
- `frontend/public/img/default-avatar.svg`
- `frontend/electron/main.js`
- `frontend/src/index.css`
- `frontend/src/App.tsx`
- `frontend/src/pages/ChatsPage.tsx`
- `frontend/src/pages/ProfilePage.tsx`
- `frontend/src/features/menu/SlideMenu.tsx`
- `frontend/src/features/chats/ChatList.tsx`
- `frontend/src/features/chats/ChatWindow.tsx`
- `frontend/src/features/chats/MessageList.tsx`
- `frontend/src/features/chats/MessageItem.tsx`
- `frontend/src/features/chats/MessageComposer.tsx`
- `frontend/src/features/chats/ForwardModal.tsx`
- `frontend/src/features/chats/CreateGroupModal.tsx`
- `frontend/src/features/chats/AddMembersModal.tsx`
- `frontend/src/features/chats/GroupInfoPanel.tsx`
- `frontend/src/features/chats/EmojiPicker.css`
- `frontend/src/features/chats/threadCrypto.ts`
- `frontend/src/features/chats/threadCrypto.test.ts`
- `frontend/src/features/contacts/ContactsModal.tsx`
- `frontend/src/features/profile/ProfileModal.tsx`
- `frontend/src/features/profile/UserProfileModal.tsx`
- `frontend/src/features/calls/ActiveCallOverlay.tsx`
- `frontend/src/features/calls/IncomingCallModal.tsx`
- `frontend/src/features/auth/LazyVaultModal.tsx`
- `frontend/src/features/applock/LockScreen.tsx`
- `frontend/src/features/applock/EnableAppLockOffer.tsx`
- `frontend/src/shared/components/Avatar.tsx`
- `frontend/src/shared/components/ConfirmDialog.tsx`
- `frontend/src/shared/hooks/useModalBehavior.ts`
- `frontend/src/styles/base.css`
- `frontend/src/styles/layout.css`
- `frontend/src/styles/menu.css`
- `frontend/src/styles/chat.css`
- `frontend/src/styles/e2e.css`
- `frontend/src/styles/auth.css`
- `frontend/src/styles/modals.css`
- `frontend/src/styles/groups.css`
- `frontend/src/styles/calls.css`

---

## Verification Commands & Results

1. **ESLint (`npm run lint`)**:
   - `cd frontend && npm run lint` → **Passed (0 errors, 0 warnings)**.
2. **Unit & Regression Tests (`npm test -- --run`)**:
   - `cd frontend && npm test -- --run` → **Passed (7 test files, 61 tests passed)**, including E2E vault/message/attachment crypto (`e2e.test.ts`), key pinning (`keyPins.test.ts`), identity (`identity.test.ts`), app lock (`appLock.test.ts`), utilities (`date.test.ts`, `linkify.test.ts`), and cold deep-link decryption lifecycle (`threadCrypto.test.ts`).
3. **Production Web Build (`npm run build`)**:
   - `cd frontend && npm run build` (`tsc -b && vite build`) → **Passed**.
4. **Desktop Bundle Build (`npm run build:desktop`)**:
   - `cd frontend && npm run build:desktop` (`tsc -b && vite build --mode desktop`) → **Passed**.
5. **Responsive & Runtime Verification**:
   - Verified across `390px` (mobile), `768px` (tablet), and `1440px` (desktop) in both dark (`#0D1017` / `#191D28` / `#493B67` / `#7C5CFF`) and light (`#F0F3F8` / `#FFFFFF` / `#E6DCFA` / `#6D4AFF`) themes, including mobile `56×56` FAB outside scroll container, `48×48` Back button separated from avatar/profile trigger, draft preservation across Back/reselect, drawer focus trap & `inert` state when closed, compact `<= 460px` desktop bubbles without redundant 1:1 sender labels, and cold deep-link `/?chat=N` E2E decryption.
