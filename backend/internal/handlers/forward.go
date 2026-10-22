package handlers

import (
	"messenger/internal/models"
	"messenger/internal/services"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// forwardAttachmentInput is one attachment to forward: the source attachment id
// plus the file_key re-wrapped (client-side) for the destination chat's
// recipients. The body itself is server-copied — never re-uploaded.
type forwardAttachmentInput struct {
	SourceAttachmentID uint                     `json:"source_attachment_id"`
	Envelopes          []wireAttachmentEnvelope `json:"envelopes"`
}

// forwardRequest is the body of POST /api/chats/:id/forward. The text part is a
// normal scheme=2 payload (1-on-1: text+iv; group: envelopes) re-encrypted for
// the destination. Attachments reference source attachments + carry re-wrapped
// file_key envelopes.
type forwardRequest struct {
	Text                string                   `json:"text"`
	IV                  string                   `json:"iv"`
	Scheme              uint8                    `json:"scheme"`
	Envelopes           []messageEnvelopeAction  `json:"envelopes"`
	ForwardedFromUserID uint                     `json:"forwarded_from_user_id"`
	Attachments         []forwardAttachmentInput `json:"attachments"`
}

// ForwardMessageAPI forwards a message (text and/or attachments) into another
// chat. The client has already re-encrypted the text and re-wrapped each
// attachment's file_key for the destination's recipients, so the server only
// creates the message, server-copies the (encrypted) attachment bodies, and
// broadcasts — it never sees plaintext or any file_key (E2E intact).
func (h *webSocketHandler) ForwardMessageAPI(c *gin.Context) {
	userID, ok := requireUserID(c)
	if !ok {
		return
	}
	destChatID, err := parseUintParam(c, "id")
	if err != nil {
		sendBadRequest(c, "Invalid chat ID")
		return
	}
	var req forwardRequest
	if bindErr := c.ShouldBindJSON(&req); bindErr != nil {
		sendBadRequest(c, "Invalid request body")
		return
	}
	if req.Scheme != models.SchemeClientSide {
		sendError(c, http.StatusBadRequest, codeClientUpdateRequired, "Client update required: server-side encryption is no longer supported")
		return
	}

	ctx := c.Request.Context()
	chat, err := h.chatService.FindChatByIDLight(ctx, destChatID)
	if err != nil {
		sendForbidden(c, "Access denied")
		return
	}

	// Reuse the normal send pipeline for the message body — it enforces
	// membership, persists scheme=2 text/envelopes, queues unread for offline
	// recipients, and fires a push. forwarded_from_user_id rides along.
	msgData := messageAction{
		Action:              "send",
		ChatID:              destChatID,
		Text:                req.Text,
		IV:                  req.IV,
		Scheme:              req.Scheme,
		Envelopes:           req.Envelopes,
		ForwardedFromUserID: req.ForwardedFromUserID,
	}

	var message *models.Message
	if chat.IsGroup {
		message, err = h.handleSendGroupMessage(ctx, userID, chat, msgData)
	} else {
		message, err = h.handleSendDirectMessage(ctx, userID, chat, msgData)
	}
	if err != nil {
		h.logger.Warn("forward: message creation failed",
			zap.Error(err),
			zap.Uint("dest_chat", destChatID),
			zap.Uint("user", userID),
		)
		sendBadRequest(c, "Failed to forward message")
		return
	}

	// Make the message visible (chat-list preview + live bubble); attachments,
	// if any, arrive via a following attachments_added broadcast.
	h.broadcastNewMessage(ctx, userID, msgData, message)

	if len(req.Attachments) > 0 {
		h.forwardAttachments(c, userID, destChatID, message.ID, req.Attachments)
	}

	sendSuccess(c, gin.H{"success": true, "message_id": message.ID})
}

// forwardAttachments server-copies each source attachment into the new message
// and broadcasts attachments_added for those that succeed. Best-effort per
// attachment — one bad source doesn't sink the rest of the forward.
func (h *webSocketHandler) forwardAttachments(c *gin.Context, userID, destChatID, messageID uint, inputs []forwardAttachmentInput) {
	if h.attachmentService == nil {
		return
	}
	ctx := c.Request.Context()
	copied := make([]*models.Attachment, 0, len(inputs))
	metas := make([]services.AttachmentMetaInput, 0, len(inputs))
	for _, in := range inputs {
		envs := make([]services.AttachmentEnvelopeInput, len(in.Envelopes))
		for i, e := range in.Envelopes {
			envs[i] = services.AttachmentEnvelopeInput{
				RecipientID:      e.RecipientID,
				EncryptedFileKey: e.EncryptedFileKey,
				IV:               e.IV,
			}
		}
		att, err := h.attachmentService.ForwardAttachment(ctx, in.SourceAttachmentID, messageID, destChatID, userID, envs)
		if err != nil {
			h.logger.Warn("forward attachment failed",
				zap.Error(err),
				zap.Uint("source_attachment_id", in.SourceAttachmentID),
				zap.Uint("message_id", messageID),
			)
			continue
		}
		copied = append(copied, att)
		metas = append(metas, services.AttachmentMetaInput{
			FileIV:            att.FileIV,
			EncryptedMetadata: att.EncryptedMetadata,
			MetadataIV:        att.MetadataIV,
			Envelopes:         envs,
		})
	}
	if len(copied) > 0 {
		serialized := serializeAttachmentsForBroadcast(c, h.attachmentService, copied, metas, h.fileStorage)
		h.BroadcastAttachmentsAdded(destChatID, messageID, serialized)
	}
}
