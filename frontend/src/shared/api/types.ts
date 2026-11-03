// API Response types according to API_FULL_DOCUMENTATION.md

// Auth responses - unified type for login/register
export type AuthResponse = {
  user_id: number
  username: string
  name: string
  token: string
  // E2E vault material — null/absent when the user hasn't onboarded into E2E yet.
  // See shared/crypto/e2e.ts for how these get used to derive the account_key.
  vault_salt?: string | null
  encrypted_account_key?: string | null
}

// Aliases for backwards compatibility
export type AuthLoginResponse = AuthResponse
export type AuthRegisterResponse = AuthResponse

// User Profile
export type UserProfile = {
  id: number
  username: string
  name: string
  avatar_url?: string
  is_own?: boolean
  is_contact?: boolean
  created_at?: string
  updated_at?: string
  // Same E2E vault material echoed back on /api/auth/me so the app shell can decide
  // whether this user still has to set up E2E (LazyVaultModal) — E2E is mandatory.
  vault_salt?: string | null
  encrypted_account_key?: string | null
  // X25519 public key (base64) — present on GET /api/profile/:id for peers.
  public_key?: string | null
}

// Chats
export type ChatListResponse = {
  chats: ChatItem[]
}

export type ChatItem = {
  id: number
  is_group: boolean
  avatar_url?: string
  last_message?: string
  unread_count: number
  updated_at: string

  // For scheme=2 last messages, the server attaches the raw ciphertext/iv +
  // sender_id so the client can decrypt the preview locally. If empty, fall
  // back to last_message (which will be the "🔒 placeholder" the server
  // computed). For 1-on-1 the sender is either the peer or ourselves; for
  // groups the per-user envelope is pre-resolved server-side so this is
  // the ciphertext addressed to us specifically.
  last_message_scheme?: number
  last_message_ciphertext?: string
  last_message_iv?: string
  last_message_sender_id?: number

  // 1-on-1 fields (omitted for groups)
  other_user_id?: number
  other_user_name?: string

  // True for the user's "Saved Messages" self-chat. Client renders a
  // bookmark icon + the localised title "Избранное" and hides the
  // delete-chat affordance; clear-chat is still allowed.
  is_favorites?: boolean

  // Group fields (omitted for 1-on-1)
  group_name?: string
  member_count?: number
}

export type ChatCreateResponse = {
  id: number
  user1_id: number
  user2_id: number
  created_at: string
}

// Messages
export type MessagesResponse = {
  messages: Message[]
}

export type Message = {
  id: number
  chat_id: number
  user_id: number
  text: string
  type?: 'user' | 'system'
  reply_to_id?: number | null
  // Original author's user id when this message was forwarded from another chat.
  forwarded_from_user_id?: number | null
  edited_at?: string | null
  is_deleted: boolean
  created_at: string
  attachments: Attachment[]
  // E2E scheme (2 = client-encrypted, ciphertext stored in `text` + nonce in `iv`).
  // Absent or 1 means the server decrypted the text before sending it to us — display as-is.
  scheme?: number
  iv?: string
}

// Group types
export type GroupMember = {
  user_id: number
  username: string
  name: string
  avatar_url?: string
  role: 'creator' | 'admin' | 'member'
  is_online: boolean
}

export type GroupCreateResponse = {
  id: number
  name: string
  is_group: boolean
  members: GroupMember[]
  created_at: string
}

export type GroupInfoResponse = {
  id: number
  name: string
  avatar_url?: string
  creator_id: number
  members: GroupMember[]
  created_at: string
}

// Attachments. All metadata fields the operator could read have been moved
// into encrypted_metadata; the only plaintext bits left are file_size (S3
// necessarily knows it) and the storage key. file_name + mime_type live
// encrypted under file_key alongside the body and are recovered client-side
// after decryption.
export type Attachment = {
  id: number
  message_id?: number
  storage_key?: string
  file_size: number
  url?: string
  thumbnail_key?: string
  width?: number
  height?: number
  duration?: number
  created_at?: string
  // E2E fields. For scheme=2 attachments the body in MinIO is AES-GCM
  // ciphertext encrypted with a random file_key; that file_key is wrapped
  // per-recipient under chat_key. Server pre-resolves the caller's envelope
  // (encrypted_file_key + envelope_iv). file_iv is the body's own nonce,
  // same for all recipients. encrypted_metadata wraps {fileName, mimeType}
  // under the same file_key as the body — server never sees plaintext.
  encrypted_file_key?: string
  envelope_iv?: string
  file_iv?: string
  encrypted_metadata?: string
  metadata_iv?: string
}

// User list item (used in contacts list, search results)
export type UserListItem = {
  id: number
  username: string
  name: string
  avatar_url?: string
}

// User search response
export type UserSearchResponse = {
  users: UserListItem[]
}

// Enriched contacts response (backend returns UserListItem array)
export type EnrichedContactsResponse = {
  contacts: UserListItem[]
}

// Avatar
export type AvatarUploadResponse = {
  success: boolean
  avatar_url: string
}

// Generic API responses
export type ApiError = {
  error: string
}

// One per-recipient envelope in a group scheme=2 send/edit. The sender encrypts
// the same plaintext once per recipient (Variant A pairwise) and ships the
// resulting array here. Top-level text/iv on the send/edit action are empty by
// convention when envelopes are present.
export type WSEnvelope = {
  recipient_id: number
  ciphertext: string
  iv: string
}

// WebSocket message types (client -> server)
// All messages must include chat_id since we use a global WebSocket connection
export type WSMessageSend = {
  action: 'send'
  chat_id: number
  text: string
  reply_to_id?: number
  // Set when forwarding: the original author's user id (attribution only — the
  // body is re-encrypted for this chat).
  forwarded_from_user_id?: number
  // For E2E (scheme=2) sends in 1-on-1: text is ciphertext, iv is the GCM nonce, scheme is 2.
  // For group scheme=2: text & iv are empty, envelopes carries one per recipient.
  // For legacy sends: omit all four; server defaults to scheme=1 server-side encryption.
  scheme?: number
  iv?: string
  envelopes?: WSEnvelope[]
}

export type WSMessageEdit = {
  action: 'edit'
  chat_id: number
  message_id: number
  text: string
  scheme?: number
  iv?: string
  envelopes?: WSEnvelope[]
}

export type WSMessageDelete = {
  action: 'delete'
  chat_id: number
  message_id: number
}

export type WSMessageMarkRead = {
  action: 'mark_read'
  chat_id: number
  // Highest message id the client has read — advances the read-receipt pointer.
  up_to_message_id?: number
}

// Delivery acknowledgement: the client received message_id in a chat it isn't
// currently viewing. Advances the peer's delivered pointer so the author's
// bubbles show ✓✓ (delivered). 1-on-1 only on the server side.
export type WSMessageDelivered = {
  action: 'delivered'
  chat_id: number
  message_id: number
}

// Call signaling (client -> server)
export type WSCallOffer = {
  action: 'call_offer'
  chat_id: number
  call_id: string
  sdp: string
  sdp_type: 'offer'
}

export type WSCallAnswer = {
  action: 'call_answer'
  chat_id: number
  call_id: string
  sdp: string
  sdp_type: 'answer'
}

export type WSCallIce = {
  action: 'call_ice'
  chat_id: number
  call_id: string
  candidate: string
}

export type WSCallHangup = {
  action: 'call_hangup'
  chat_id: number
  call_id: string
}

export type WSCallReject = {
  action: 'call_reject'
  chat_id: number
  call_id: string
}

// Callee → server: "I'm online now (via the doorbell push) and ready for a
// fresh offer." Relayed to the caller, who re-offers.
export type WSCallReady = {
  action: 'call_ready'
  chat_id: number
  call_id: string
}

// Caller → server: ring window expired with no answer. Server posts the
// "Пропущенный звонок" system message (guarded against the registered caller).
export type WSCallMissed = {
  action: 'call_missed'
  chat_id: number
  call_id: string
}

export type WSMessageAction =
  | WSMessageSend | WSMessageEdit | WSMessageDelete | WSMessageMarkRead | WSMessageDelivered
  | WSCallOffer | WSCallAnswer | WSCallIce | WSCallHangup | WSCallReject | WSCallReady | WSCallMissed

// WebSocket events (server -> client)
export type WSEventNew = {
  action: 'new'
  id: number
  chat_id: number
  user_id: number
  text: string
  // Present for server-generated system messages (e.g. "Пропущенный звонок").
  // Absent/"user" for normal messages.
  type?: 'user' | 'system'
  reply_to_id?: number | null
  forwarded_from_user_id?: number | null
  edited_at?: string | null
  is_deleted: boolean
  created_at: string
  updated_at?: string
  attachments?: Attachment[]
  // scheme=2 means text+iv are E2E ciphertext; decrypt with account_key before display.
  scheme?: number
  iv?: string
  // For group scheme=2 sends/edits the broadcast carries per-recipient envelopes
  // instead of (or in addition to) top-level text/iv. Each client picks the
  // envelope addressed to its own user_id and decrypts that.
  envelopes?: WSEnvelope[]
  // True when this is an offline-replay on reconnect (server drained the unread
  // queue). The client must NOT re-bump the unread badge for these — loadChats
  // already counts them via the server's unread_count.
  replayed?: boolean
}

export type WSEventAttachmentsAdded = {
  action: 'attachments_added'
  chat_id: number
  message_id: number
  attachments: Attachment[]
}

export type WSEventEdit = {
  action: 'edit'
  id: number
  chat_id: number
  text: string
  edited_at?: string
  scheme?: number
  iv?: string
  envelopes?: WSEnvelope[]
}

export type WSEventDelete = {
  action: 'delete'
  id: number
  chat_id: number
  is_deleted: boolean
}

export type WSEventPresenceChanged = {
  action: 'presence_changed'
  user_id: number
  is_online: boolean
  last_seen?: string
}

export type WSEventChatCleared = {
  action: 'chat_cleared'
  chat_id: number
  user_id: number
}

// Read-receipt update (1-on-1). The peer (user_id) has delivered or read every
// message up to up_to_message_id; the author bumps its per-chat pointer so sent
// bubbles flip ✓ → ✓✓ (grey delivered) → ✓✓ (blue read).
export type WSEventMessageStatus = {
  action: 'message_status'
  chat_id: number
  user_id: number
  status: 'delivered' | 'read'
  up_to_message_id: number
}

export type WSEventChatDeleted = {
  action: 'chat_deleted'
  chat_id: number
  user_id: number
}

// Group WebSocket events (server -> client)
export type WSEventMemberAdded = {
  action: 'member_added'
  chat_id: number
  actor_id: number
  members: GroupMember[]
}

export type WSEventMemberRemoved = {
  action: 'member_removed'
  chat_id: number
  actor_id: number
  user_id: number
}

export type WSEventMemberLeft = {
  action: 'member_left'
  chat_id: number
  user_id: number
}

export type WSEventGroupUpdated = {
  action: 'group_updated'
  chat_id: number
  actor_id: number
  name?: string
  avatar_url?: string
}

export type WSEventRoleChanged = {
  action: 'role_changed'
  chat_id: number
  actor_id: number
  user_id: number
  new_role: string
}

export type WSEventGroupDeleted = {
  action: 'group_deleted'
  chat_id: number
  actor_id: number
}

// Pinned messages
export type PinnedMessage = {
  id: number
  chat_id: number
  message_id: number
  pinned_by: number
  created_at: string
  message: Message
}

export type WSEventMessagePinned = {
  action: 'message_pinned'
  chat_id: number
  message_id: number
}

export type WSEventMessageUnpinned = {
  action: 'message_unpinned'
  chat_id: number
  message_id: number
}

// Call signaling events (server -> client)
export type WSEventCallOffer = {
  action: 'call_offer'
  chat_id: number
  call_id: string
  user_id: number
  sdp: string
  sdp_type: 'offer'
}

export type WSEventCallAnswer = {
  action: 'call_answer'
  chat_id: number
  call_id: string
  user_id: number
  sdp: string
  sdp_type: 'answer'
}

export type WSEventCallIce = {
  action: 'call_ice'
  chat_id: number
  call_id: string
  user_id: number
  candidate: string
}

export type WSEventCallHangup = {
  action: 'call_hangup'
  chat_id: number
  call_id: string
  user_id: number
}

export type WSEventCallReject = {
  action: 'call_reject'
  chat_id: number
  call_id: string
  user_id: number
}

// Server → caller: the callee came online and is ready for a fresh offer.
export type WSEventCallReady = {
  action: 'call_ready'
  chat_id: number
  call_id: string
  user_id: number
}

export type WSEventPrefsUpdated = {
  action: 'prefs_updated'
  scope: 'account' | 'chat' | 'bulk'
  user_id: number
  chat_id?: number
  account?: unknown
  preference?: unknown
  effective?: unknown
  result?: unknown
}

export type WSEvent =
  | WSEventNew
  | WSEventEdit
  | WSEventDelete
  | WSEventAttachmentsAdded
  | WSEventPresenceChanged
  | WSEventChatCleared
  | WSEventChatDeleted
  | WSEventMessageStatus
  | WSEventMemberAdded
  | WSEventMemberRemoved
  | WSEventMemberLeft
  | WSEventGroupUpdated
  | WSEventRoleChanged
  | WSEventGroupDeleted
  | WSEventMessagePinned
  | WSEventMessageUnpinned
  | WSEventCallOffer
  | WSEventCallAnswer
  | WSEventCallIce
  | WSEventCallHangup
  | WSEventCallReject
  | WSEventCallReady
  | WSEventPrefsUpdated
  | ApiError
