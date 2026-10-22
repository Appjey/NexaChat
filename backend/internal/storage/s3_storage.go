package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	"github.com/google/uuid"
)

// presignCacheSafetyMargin is subtracted from the presigned URL expiry before
// we consider it "stale" — ensures clients don't start a download 10 seconds
// before the URL expires.
const presignCacheSafetyMargin = 30 * time.Second

// presignCacheMaxEntries caps the in-memory cache to avoid unbounded growth.
// Old entries are simply evicted wholesale when the cap is hit — the cache is
// opportunistic, not authoritative.
const presignCacheMaxEntries = 10_000

type cachedPresignedURL struct {
	url       string
	expiresAt time.Time
}

// S3Storage implements Storage interface for S3-compatible storage (MinIO, AWS S3)
type S3Storage struct {
	client          *s3.Client
	bucket          string
	region          string
	presignedExpiry time.Duration
	presignClient   *s3.PresignClient
	// urlCache memoises presigned URLs for the remainder of their validity window.
	// Without it, every message fetch with N attachments hits PresignGetObject N times
	// (HMAC signing per call). A single chat open with lots of media can be dozens of
	// signs per request.
	urlCacheMu sync.RWMutex
	urlCache   map[string]cachedPresignedURL
}

// Verify interface compliance at compile time
var _ Storage = (*S3Storage)(nil)

// NewS3Storage creates a new S3Storage instance
func NewS3Storage(config *StorageConfig) (*S3Storage, error) {
	// Create AWS config
	awsConfig := aws.Config{
		Region: config.S3Region,
		Credentials: credentials.NewStaticCredentialsProvider(
			config.S3AccessKey,
			config.S3SecretKey,
			"",
		),
	}

	// Create S3 client with internal endpoint for backend operations
	clientOptions := func(o *s3.Options) {
		o.UsePathStyle = true // Critical for MinIO
		if config.S3Endpoint != "" {
			o.BaseEndpoint = aws.String(config.S3Endpoint)
		}
	}

	client := s3.NewFromConfig(awsConfig, clientOptions)

	// Create separate client for presigned URLs with public endpoint
	publicClientOptions := func(o *s3.Options) {
		o.UsePathStyle = true
		if config.S3PublicEndpoint != "" {
			o.BaseEndpoint = aws.String(config.S3PublicEndpoint)
		}
	}

	publicClient := s3.NewFromConfig(awsConfig, publicClientOptions)
	presignClient := s3.NewPresignClient(publicClient)

	return &S3Storage{
		client:          client,
		bucket:          config.S3Bucket,
		region:          config.S3Region,
		presignedExpiry: time.Duration(config.S3PresignedExpiry) * time.Second,
		presignClient:   presignClient,
		urlCache:        make(map[string]cachedPresignedURL),
	}, nil
}

// EnsureBucket makes sure the configured bucket exists, creating it when it
// does not. It is idempotent and safe to run on every startup; the returned
// bool reports whether this call created the bucket.
//
// This replaces the former `minio-init` one-shot compose service (which ran
// `mc mb --ignore-existing` from the minio/mc image): the backend is the only
// writer, so it owns provisioning of its own bucket and the stack no longer
// needs a second MinIO-specific image just to run one command.
func (s *S3Storage) EnsureBucket(ctx context.Context) (bool, error) {
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)})
	if err == nil {
		return false, nil
	}
	if !isBucketMissing(err) {
		return false, fmt.Errorf("head bucket %q: %w", s.bucket, err)
	}

	input := &s3.CreateBucketInput{Bucket: aws.String(s.bucket)}
	// S3 proper rejects a LocationConstraint of us-east-1 and requires it for
	// every other region; MinIO accepts both forms.
	if s.region != "" && s.region != "us-east-1" {
		input.CreateBucketConfiguration = &types.CreateBucketConfiguration{
			LocationConstraint: types.BucketLocationConstraint(s.region),
		}
	}
	if _, err := s.client.CreateBucket(ctx, input); err != nil {
		// Lost a race with another replica creating the same bucket — fine.
		var owned *types.BucketAlreadyOwnedByYou
		var exists *types.BucketAlreadyExists
		if errors.As(err, &owned) || errors.As(err, &exists) {
			return false, nil
		}
		return false, fmt.Errorf("create bucket %q: %w", s.bucket, err)
	}
	return true, nil
}

// isBucketMissing reports whether a HeadBucket error means "no such bucket" as
// opposed to a transport/auth/permission failure. HeadBucket replies with a
// bodyless 404, which the SDK surfaces as types.NotFound; some S3-compatible
// servers return NoSuchBucket instead.
func isBucketMissing(err error) bool {
	var notFound *types.NotFound
	var noSuchBucket *types.NoSuchBucket
	if errors.As(err, &notFound) || errors.As(err, &noSuchBucket) {
		return true
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.ErrorCode() {
		case "NotFound", "NoSuchBucket":
			return true
		}
	}
	return false
}

// Save stores a file in S3 and returns metadata
func (s *S3Storage) Save(reader io.Reader, fileName, contentType string, _ int64) (*FileMetadata, error) {
	ctx := context.Background()

	// Generate unique filename
	ext := filepath.Ext(fileName)
	uniqueID := uuid.New().String()
	uniqueFileName := fmt.Sprintf("%s%s", uniqueID, ext)

	// Create date-based directory structure
	now := time.Now()
	storageKey := filepath.ToSlash(filepath.Join(
		"files",
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", now.Month()),
		fmt.Sprintf("%02d", now.Day()),
		uniqueFileName,
	))

	// Read data into buffer
	var buf bytes.Buffer
	written, err := io.Copy(&buf, reader)
	if err != nil {
		return nil, fmt.Errorf("failed to read file data: %w", err)
	}

	// Upload to S3
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.bucket),
		Key:           aws.String(storageKey),
		Body:          bytes.NewReader(buf.Bytes()),
		ContentType:   aws.String(contentType),
		ContentLength: &written,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to upload to S3: %w", err)
	}

	return &FileMetadata{
		Key:         storageKey,
		FileName:    fileName,
		ContentType: contentType,
		Size:        written,
		URL:         s.GetURL(storageKey),
	}, nil
}

// Get retrieves a file from S3
func (s *S3Storage) Get(key string) (io.ReadCloser, error) {
	ctx := context.Background()

	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get object from S3: %w", err)
	}

	return result.Body, nil
}

// Copy server-side-duplicates an object into a fresh date-based key and returns
// the new key. Uses S3 CopyObject so the (potentially large) ciphertext is
// copied within the storage backend — it never streams through this process.
func (s *S3Storage) Copy(sourceKey string) (string, error) {
	ctx := context.Background()

	ext := filepath.Ext(sourceKey)
	uniqueFileName := fmt.Sprintf("%s%s", uuid.New().String(), ext)
	now := time.Now()
	newKey := filepath.ToSlash(filepath.Join(
		"files",
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", now.Month()),
		fmt.Sprintf("%02d", now.Day()),
		uniqueFileName,
	))

	// CopySource is "<bucket>/<key>". Our keys are uuid/date segments only
	// (no characters needing percent-encoding), so a plain join is safe.
	copySource := fmt.Sprintf("%s/%s", s.bucket, sourceKey)
	if _, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String(s.bucket),
		CopySource: aws.String(copySource),
		Key:        aws.String(newKey),
	}); err != nil {
		return "", fmt.Errorf("failed to copy object in S3: %w", err)
	}

	return newKey, nil
}

// Delete removes a file from S3
func (s *S3Storage) Delete(key string) error {
	ctx := context.Background()

	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("failed to delete object from S3: %w", err)
	}

	// Invalidate the presigned URL cache for this key so we don't serve a link to a
	// just-deleted object.
	s.urlCacheMu.Lock()
	delete(s.urlCache, key)
	s.urlCacheMu.Unlock()

	return nil
}

// GetURL returns a presigned URL for file access. Result is cached in-process for
// most of the presigned-expiry window (minus a safety margin), so repeated calls
// for the same key during chat rendering don't re-sign on every hit.
func (s *S3Storage) GetURL(key string) string {
	// Fast path: cached and still valid.
	s.urlCacheMu.RLock()
	cached, ok := s.urlCache[key]
	s.urlCacheMu.RUnlock()
	if ok && time.Now().Before(cached.expiresAt) {
		return cached.url
	}

	// Slow path: sign a fresh URL.
	ctx := context.Background()
	presignedReq, err := s.presignClient.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}, func(opts *s3.PresignOptions) {
		opts.Expires = s.presignedExpiry
	})
	if err != nil {
		return fmt.Sprintf("s3://%s/%s", s.bucket, key)
	}

	expiresAt := time.Now().Add(s.presignedExpiry - presignCacheSafetyMargin)
	s.urlCacheMu.Lock()
	// Simple size cap: on overflow, reset the cache. Opportunistic eviction is fine —
	// signing is cheap enough that losing a few entries costs nothing.
	if len(s.urlCache) >= presignCacheMaxEntries {
		s.urlCache = make(map[string]cachedPresignedURL)
	}
	s.urlCache[key] = cachedPresignedURL{url: presignedReq.URL, expiresAt: expiresAt}
	s.urlCacheMu.Unlock()

	return presignedReq.URL
}
