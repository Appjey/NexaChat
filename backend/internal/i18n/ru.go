// Package i18n holds every user-visible string the server itself produces:
// system messages persisted into chats ("X created the group"), push
// notification copy and chat-list placeholders. The product ships in Russian,
// and this file is the one place that copy lives.
//
// API error responses are deliberately NOT here. They are English with a
// machine-readable `code` (handlers/response.go) that the client maps to its
// own localized copy (frontend/src/shared/api/errors.ts) — the server should
// not pick a language for an HTTP client.
package i18n

import "fmt"

// Placeholders and push copy.
const (
	// AttachmentPlaceholder stands in for a message body the server cannot
	// read (E2E) when the message carries files — chat-list preview and push.
	AttachmentPlaceholder = "📎 Вложение"
	// EncryptedPlaceholder is the chat-list preview for an E2E message body.
	EncryptedPlaceholder = "🔒 Зашифрованное сообщение"
	// NewMessagePush is the push body for an E2E message (the server never
	// sees the text).
	NewMessagePush = "Новое сообщение"
	// IncomingCallTitle is the push title for an incoming call.
	IncomingCallTitle = "Входящий звонок"
	// IncomingCallFallbackName is the push body when the caller's name is unknown.
	IncomingCallFallbackName = "Входящий вызов"
	// MissedCall is the system message posted after an unanswered call.
	MissedCall = "Пропущенный звонок"
	// SomeoneName / UnknownUser / UnknownUserLower fill in for a display name
	// that could not be resolved (deleted account, lookup failure).
	SomeoneName      = "Кто-то"
	UnknownUser      = "Пользователь"
	UnknownUserLower = "пользователь"
)

// System messages (persisted as plaintext rows of type "system").

func GroupCreated(actor string) string { return fmt.Sprintf("%s создал(а) группу", actor) }

func MemberAdded(member, actor string) string {
	return fmt.Sprintf("%s добавлен(а) пользователем %s", member, actor)
}

func MemberRemoved(target, actor string) string {
	return fmt.Sprintf("%s удалён(а) пользователем %s", target, actor)
}

func MemberLeft(user string) string { return fmt.Sprintf("%s покинул(а) группу", user) }

func RolePromoted(target, actor string) string {
	return fmt.Sprintf("%s назначен(а) администратором пользователем %s", target, actor)
}

func RoleDemoted(target, actor string) string {
	return fmt.Sprintf("%s снят(а) с должности администратора пользователем %s", target, actor)
}

func GroupRenamed(actor, name string) string {
	return fmt.Sprintf("%s изменил(а) название группы на «%s»", actor, name)
}

func MessagePinned(actor string) string {
	return fmt.Sprintf("%s закрепил(а) сообщение", actor)
}

func MessageUnpinned(actor string) string {
	return fmt.Sprintf("%s открепил(а) сообщение", actor)
}
