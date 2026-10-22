package services

import (
	"context"
	"errors"
	"fmt"
	"mime/multipart"

	"messenger/internal/models"
	"messenger/internal/repositories"
	"messenger/internal/storage"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	ErrMessageNotFound      = errors.New("message not found")
	ErrNotMessageOwner      = errors.New("unauthorized: not message owner")
	ErrAttachmentNotFound   = errors.New("attachment not found")
	ErrAttachmentMetaShape  = errors.New("attachment metadata count must equal file count")
	ErrAttachmentMetaFields = errors.New("attachment metadata: file_iv and envelopes are required")
)

// AttachmentEnvelopeInput is one per-recipient wrapped file_key, mirrored from
// the wire-level multipart metadata into the service-layer shape.
type AttachmentEnvelopeInput struct {
	RecipientID      uint
	EncryptedFileKey string
	IV               string
}

// AttachmentMetaInput is the per-file metadata accompanying a multipart upload:
// the file body's own AES-GCM IV (so recipients can decrypt the blob once they
// have file_key) plus the per-recipient wrapped file_key envelopes.
//
// EncryptedMetadata + MetadataIV carry the AES-GCM-wrapped {file_name,
// mime_type} blob (under the same file_key that encrypts the body). The
// server records them verbatim and never sees the plaintext, so filename
// and claimed mime type stay private from the operator. FileSize comes
// from the multipart part itself and is necessarily server-visible.
type AttachmentMetaInput struct {
	FileIV            string
	EncryptedMetadata string
	MetadataIV        string
	Envelopes         []AttachmentEnvelopeInput
}

// AttachmentService handles business logic for attachments
type AttachmentService struct {
	db              *gorm.DB
	logger          *zap.Logger
	attachmentRepo  *repositories.AttachmentRepo
	envelopeRepo    *repositories.AttachmentEnvelopeRepo
	messageRepo     *repositories.MessageRepo
	chatRepo        *repositories.ChatRepo
	participantRepo *repositories.ChatParticipantRepo
	storage         storage.Storage
	validator       *fileValidator
}

// NewAttachmentService creates a new AttachmentService instance
func NewAttachmentService(
	db *gorm.DB,
	logger *zap.Logger,
	attachmentRepo *repositories.AttachmentRepo,
	envelopeRepo *repositories.AttachmentEnvelopeRepo,
	messageRepo *repositories.MessageRepo,
	chatRepo *repositories.ChatRepo,
	participantRepo *repositories.ChatParticipantRepo,
	fileStorage storage.Storage,
) *AttachmentService {
	return &AttachmentService{
		db:              db,
		logger:          logger,
		attachmentRepo:  attachmentRepo,
		envelopeRepo:    envelopeRepo,
		messageRepo:     messageRepo,
		chatRepo:        chatRepo,
		participantRepo: participantRepo,
		storage:         fileStorage,
		validator:       &fileValidator{},
	}
}

// UploadAttachments uploads multiple files, encrypted client-side, plus their
// per-recipient envelopes. The flow is:
//
//  1. Validate ownership of the parent message + envelope shape (every chat
//     participant addressed exactly once, sender included).
//  2. Persist each ciphertext blob to S3.
//  3. In a single transaction, insert the Attachment rows and their envelope
//     rows. On tx failure, rollback the storage uploads.
//
// The server stores opaque blobs (the encrypted files) and opaque envelopes
// (wrapped file_keys); it can read neither without a participant's
// account_key. The body's own AES-GCM IV (FileIV) is fine to store in the
// clear — IVs don't need to be secret, just unique per (key, message).
func (s *AttachmentService) UploadAttachments(
	ctx context.Context,
	chatID, messageID, userID uint,
	files []*multipart.FileHeader,
	metas []AttachmentMetaInput,
) ([]*models.Attachment, error) {
	if len(metas) != len(files) {
		return nil, ErrAttachmentMetaShape
	}

	message, err := s.messageRepo.FindByID(ctx, messageID)
	if err != nil {
		return nil, ErrMessageNotFound
	}
	if message.UserID != userID {
		return nil, ErrNotMessageOwner
	}
	if message.ChatID != chatID {
		return nil, ErrNotMessageOwner
	}

	if err := s.validateAllMetas(ctx, chatID, userID, metas); err != nil {
		return nil, err
	}

	attachments, uploadedKeys, err := s.uploadCipherBlobs(files, messageID, metas)
	if err != nil {
		return nil, err
	}

	// Persist attachments + envelopes atomically so a partial commit can't
	// leave orphan rows on either side.
	if err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// gorm Create on []*Attachment writes back the IDs; we need them to
		// link to envelopes below.
		if createErr := tx.Create(&attachments).Error; createErr != nil {
			return fmt.Errorf("save attachments: %w", createErr)
		}
		var envelopes []models.AttachmentEnvelope
		for i, att := range attachments {
			for _, e := range metas[i].Envelopes {
				envelopes = append(envelopes, models.AttachmentEnvelope{
					AttachmentID:     att.ID,
					RecipientID:      e.RecipientID,
					EncryptedFileKey: e.EncryptedFileKey,
					IV:               e.IV,
				})
			}
		}
		if len(envelopes) == 0 {
			return nil
		}
		return s.envelopeRepo.WithTx(tx).CreateBatch(ctx, envelopes)
	}); err != nil {
		s.rollbackUploads(uploadedKeys)
		return nil, err
	}

	return attachments, nil
}

// validateAllMetas pre-validates every per-file envelope set against the
// chat's expected recipient set. Extracted from UploadAttachments to keep
// its cognitive-complexity score in check.
func (s *AttachmentService) validateAllMetas(ctx context.Context, chatID, userID uint, metas []AttachmentMetaInput) error {
	expected, err := s.chatRecipientSet(ctx, chatID, userID)
	if err != nil {
		return err
	}
	for i := range metas {
		if vErr := validateAttachmentMeta(metas[i], expected); vErr != nil {
			return fmt.Errorf("file %d: %w", i, vErr)
		}
	}
	return nil
}

// uploadCipherBlobs writes every encrypted file to object storage and returns
// the matching Attachment rows (not yet persisted) plus the list of storage
// keys so a caller can rollback on subsequent DB failure. Extracted to keep
// UploadAttachments under the linter's cognitive-complexity threshold.
func (s *AttachmentService) uploadCipherBlobs(files []*multipart.FileHeader, messageID uint, metas []AttachmentMetaInput) ([]*models.Attachment, []string, error) {
	attachments := make([]*models.Attachment, 0, len(files))
	uploadedKeys := make([]string, 0, len(files))
	for i, fileHeader := range files {
		attachment, storageKey, procErr := s.processEncryptedFileUpload(fileHeader, messageID, metas[i])
		if procErr != nil {
			s.rollbackUploads(uploadedKeys)
			return nil, nil, procErr
		}
		uploadedKeys = append(uploadedKeys, storageKey)
		attachments = append(attachments, attachment)
	}
	return attachments, uploadedKeys, nil
}

// chatRecipientSet returns the set of user_ids that must appear in any
// per-recipient envelope for this chat: both members of a 1-on-1, or every
// participant of a group. Sender membership is also asserted here.
func (s *AttachmentService) chatRecipientSet(ctx context.Context, chatID, senderID uint) (map[uint]struct{}, error) {
	chat, err := s.chatRepo.FindByIDLight(ctx, chatID)
	if err != nil {
		return nil, fmt.Errorf("find chat: %w", err)
	}
	expected := make(map[uint]struct{})
	if chat.IsGroup {
		ids, repoErr := s.participantRepo.GetParticipantUserIDs(ctx, chatID)
		if repoErr != nil {
			return nil, fmt.Errorf("fetch participants: %w", repoErr)
		}
		for _, id := range ids {
			expected[id] = struct{}{}
		}
	} else {
		expected[chat.GetUser1ID()] = struct{}{}
		expected[chat.GetUser2ID()] = struct{}{}
	}
	if _, ok := expected[senderID]; !ok {
		return nil, errors.New("sender is not a participant in this chat")
	}
	return expected, nil
}

// validateAttachmentMeta checks the envelope set covers every chat recipient
// exactly once, the body's own IV is populated, and the encrypted-metadata
// blob is present. After the legacy plaintext-name removal, an attachment
// without encrypted_metadata is uncategorizable on the receiver — reject at
// upload time rather than silently writing a row nobody can render.
func validateAttachmentMeta(meta AttachmentMetaInput, expected map[uint]struct{}) error {
	if meta.FileIV == "" || len(meta.Envelopes) == 0 {
		return ErrAttachmentMetaFields
	}
	if meta.EncryptedMetadata == "" || meta.MetadataIV == "" {
		return errors.New("encrypted_metadata and metadata_iv are required")
	}
	return validateEnvelopeSet(meta.Envelopes, expected)
}

// validateEnvelopeSet checks a per-recipient envelope set covers every expected
// recipient exactly once, each with a non-empty wrapped file_key + iv. Shared by
// the upload and forward paths.
func validateEnvelopeSet(envelopes []AttachmentEnvelopeInput, expected map[uint]struct{}) error {
	if len(envelopes) == 0 {
		return ErrAttachmentMetaFields
	}
	seen := make(map[uint]struct{}, len(envelopes))
	for _, e := range envelopes {
		if e.EncryptedFileKey == "" || e.IV == "" {
			return errors.New("envelope encrypted_file_key and iv must be non-empty")
		}
		if _, dup := seen[e.RecipientID]; dup {
			return fmt.Errorf("duplicate envelope for recipient %d", e.RecipientID)
		}
		if _, ok := expected[e.RecipientID]; !ok {
			return fmt.Errorf("envelope for non-participant %d", e.RecipientID)
		}
		seen[e.RecipientID] = struct{}{}
	}
	if len(seen) != len(expected) {
		return fmt.Errorf("envelopes cover %d of %d recipients", len(seen), len(expected))
	}
	return nil
}

// ForwardAttachment copies an existing attachment's encrypted body into a new
// (forwarded) message, reusing the body + metadata blobs and attaching
// client-supplied per-recipient envelopes (the file_key re-wrapped for the
// destination chat). E2E-preserving: the server copies opaque ciphertext and
// stores opaque envelopes — it never sees the file_key or plaintext, and the
// file is never re-uploaded (server-side S3 copy).
//
// userID (the forwarder) must be a participant of the SOURCE attachment's chat;
// the envelopes must cover the DESTINATION chat's recipient set exactly once.
func (s *AttachmentService) ForwardAttachment(
	ctx context.Context,
	sourceAttachmentID, newMessageID, destChatID, userID uint,
	envelopes []AttachmentEnvelopeInput,
) (*models.Attachment, error) {
	source, err := s.attachmentRepo.FindByIDWithMessage(ctx, sourceAttachmentID)
	if err != nil || source.Message == nil {
		return nil, ErrAttachmentNotFound
	}
	// Access: the forwarder must be a participant of the source chat
	// (chatRecipientSet asserts membership and errors otherwise).
	if _, err := s.chatRecipientSet(ctx, source.Message.ChatID, userID); err != nil {
		return nil, err
	}
	// Envelopes must cover the destination chat's recipients exactly once.
	expected, err := s.chatRecipientSet(ctx, destChatID, userID)
	if err != nil {
		return nil, err
	}
	if err := validateEnvelopeSet(envelopes, expected); err != nil {
		return nil, err
	}

	// Server-side copy of the (encrypted) body — no re-upload, no plaintext.
	newKey, err := s.storage.Copy(source.StorageKey)
	if err != nil {
		return nil, fmt.Errorf("copy attachment body: %w", err)
	}

	att := &models.Attachment{
		MessageID:         newMessageID,
		StorageKey:        newKey,
		FileSize:          source.FileSize,
		FileIV:            source.FileIV,            // body IV is reusable (same ciphertext)
		EncryptedMetadata: source.EncryptedMetadata, // wrapped under file_key, not chat_key
		MetadataIV:        source.MetadataIV,
	}
	if err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if createErr := tx.Create(att).Error; createErr != nil {
			return fmt.Errorf("save forwarded attachment: %w", createErr)
		}
		rows := make([]models.AttachmentEnvelope, 0, len(envelopes))
		for _, e := range envelopes {
			rows = append(rows, models.AttachmentEnvelope{
				AttachmentID:     att.ID,
				RecipientID:      e.RecipientID,
				EncryptedFileKey: e.EncryptedFileKey,
				IV:               e.IV,
			})
		}
		return s.envelopeRepo.WithTx(tx).CreateBatch(ctx, rows)
	}); err != nil {
		// Roll back the copied object so a failed DB tx doesn't orphan it.
		s.rollbackUploads([]string{newKey})
		return nil, err
	}

	return att, nil
}

// processEncryptedFileUpload writes one encrypted blob to S3 and returns the
// Attachment row (not yet persisted) plus the storage_key for potential
// rollback. For new (encrypted-metadata) uploads the server never sees the
// real filename or mime — both live inside meta.EncryptedMetadata, wrapped
// under the same file_key as the body. Legacy uploads (no encrypted_metadata)
// fall back to the multipart filename + claimed mime so existing chats keep
// rendering.
func (s *AttachmentService) processEncryptedFileUpload(
	fileHeader *multipart.FileHeader,
	messageID uint,
	meta AttachmentMetaInput,
) (*models.Attachment, string, error) {
	if err := s.validator.validateAttachmentSizeOnly(fileHeader); err != nil {
		return nil, "", fmt.Errorf("invalid file %s: %w", fileHeader.Filename, err)
	}

	file, err := fileHeader.Open()
	if err != nil {
		return nil, "", fmt.Errorf("open file %s: %w", fileHeader.Filename, err)
	}

	// The body is ciphertext, so we tell storage it's application/octet-stream.
	// We also pass a fixed opaque filename ("blob") instead of the multipart
	// Filename — the S3 key generator extracts the file extension for the
	// object key, and the multipart filename leaks both the real basename and
	// the user's chosen extension into the operator-visible storage_key
	// (otherwise pattern is `files/YYYY/MM/DD/{uuid}.pdf`, telling the
	// operator the file type even though mime/filename are encrypted).
	const cipherContentType = "application/octet-stream"
	const opaqueFilename = "blob"
	metadata, err := s.storage.Save(file, opaqueFilename, cipherContentType, fileHeader.Size)
	if closeErr := file.Close(); closeErr != nil {
		s.logger.Warn("failed to close file after upload", zap.Error(closeErr), zap.String("filename", fileHeader.Filename))
	}
	if err != nil {
		return nil, "", fmt.Errorf("save file %s: %w", fileHeader.Filename, err)
	}

	attachment := &models.Attachment{
		MessageID:         messageID,
		StorageKey:        metadata.Key,
		FileSize:          metadata.Size,
		FileIV:            meta.FileIV,
		EncryptedMetadata: meta.EncryptedMetadata,
		MetadataIV:        meta.MetadataIV,
	}

	return attachment, metadata.Key, nil
}

// DeleteAttachment deletes an attachment
func (s *AttachmentService) DeleteAttachment(ctx context.Context, attachmentID, userID uint) error {
	attachment, err := s.attachmentRepo.FindByID(ctx, attachmentID)
	if err != nil {
		return ErrAttachmentNotFound
	}

	// Verify ownership through message
	message, err := s.messageRepo.FindByID(ctx, attachment.MessageID)
	if err != nil || message.UserID != userID {
		return ErrNotMessageOwner
	}

	// Delete from storage
	if err := s.storage.Delete(attachment.StorageKey); err != nil {
		// Log error but continue with database deletion
		s.logger.Warn("failed to delete file from storage", zap.Error(err), zap.String("storage_key", attachment.StorageKey))
	}

	// Delete envelope rows + attachment row in one tx so we don't orphan
	// either side.
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if delErr := s.envelopeRepo.WithTx(tx).DeleteByAttachmentIDs(ctx, []uint{attachmentID}); delErr != nil {
			return fmt.Errorf("delete attachment envelopes: %w", delErr)
		}
		if delErr := tx.Delete(&models.Attachment{}, attachmentID).Error; delErr != nil {
			return fmt.Errorf("delete attachment: %w", delErr)
		}
		return nil
	})
}

// FindAttachmentWithMessage retrieves attachment with its parent message (for access checks)
func (s *AttachmentService) FindAttachmentWithMessage(ctx context.Context, attachmentID uint) (*models.Attachment, error) {
	attachment, err := s.attachmentRepo.FindByIDWithMessage(ctx, attachmentID)
	if err != nil {
		return nil, ErrAttachmentNotFound
	}
	return attachment, nil
}

// ResolveAttachmentEnvelopes is the read-path helper used when building API
// responses: for each attachment ID in the list, look up the envelope
// addressed to recipientID. Missing entries mean the recipient wasn't a
// participant at the time the file was uploaded (e.g. joined the group
// later) — UI renders "🔒 placeholder" for those.
func (s *AttachmentService) ResolveAttachmentEnvelopes(ctx context.Context, recipientID uint, attachmentIDs []uint) (map[uint]models.AttachmentEnvelope, error) {
	return s.envelopeRepo.FindForRecipient(ctx, recipientID, attachmentIDs)
}

// AllEnvelopesForAttachment returns every envelope for one attachment; used
// by the WS broadcast for attachments_added so each client picks their own.
func (s *AttachmentService) AllEnvelopesForAttachment(ctx context.Context, attachmentID uint) ([]models.AttachmentEnvelope, error) {
	return s.envelopeRepo.FindAllForAttachment(ctx, attachmentID)
}

// rollbackUploads deletes uploaded files in case of error
func (s *AttachmentService) rollbackUploads(keys []string) {
	for _, key := range keys {
		if err := s.storage.Delete(key); err != nil {
			s.logger.Warn("failed to delete file during rollback", zap.Error(err), zap.String("storage_key", key))
		}
	}
}
