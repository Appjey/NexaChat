package handlers

import (
	"errors"
	"messenger/internal/i18n"
	"time"
)

// errAccessDenied is a sentinel error used internally to signal that access check already wrote the HTTP response.
var errAccessDenied = errors.New("access denied")

// Service-layer error messages used for matching in handlers.
const (
	errMsgAccessDenied = "access denied"
	// errMsgChatAccessDenied is the WS-side wording used by every chat-scoped action.
	errMsgChatAccessDenied = "Access denied to this chat"
	errMsgChatNotFound     = "chat not found"
	errMsgMsgNotFound      = "message not found"
)

// Message and chat constants.
const (
	maxMessageSize           = 65536               // 64KB max message size (SDP payloads can be 2-5KB)
	maxRecentMessages        = 100                 // Max messages to load in recent history
	maxChatListPreview       = 100                 // Max characters for last message preview
	maxConnectionsPerUser    = 5                   // Max WebSocket connections per user
	maxMessagesPerSecond     = 10                  // Rate limit: messages per second per connection
	maxAttachmentsPerMessage = 10                  // Max file attachments per message
	writeWait                = 10 * time.Second    // Time allowed to write a message
	pongWait                 = 60 * time.Second    // Time allowed to read the next pong message
	pingPeriod               = (pongWait * 9) / 10 // Send pings to peer with this period
)

// WebRTC call signaling action names.
const (
	actionCallOffer  = "call_offer"
	actionCallAnswer = "call_answer"
	actionCallICE    = "call_ice"
	actionCallHangup = "call_hangup"
	actionCallReject = "call_reject"
	// actionCallReady: callee came online (via doorbell push) and is ready to
	// receive a fresh offer. Relayed to the caller, who re-offers.
	actionCallReady = "call_ready"
	// actionCallMissed: caller's ring window expired with no answer. Posts the
	// "Пропущенный звонок" system message.
	actionCallMissed = "call_missed"
)

// callMissedText is the plaintext body of the missed-call system message.
const callMissedText = i18n.MissedCall

// Multipart form parse limits.
const (
	multipartFormSizeAttachment = 512 << 20 // 512 MB
	multipartFormSizeAvatar     = 10 << 20  // 10 MB
)
