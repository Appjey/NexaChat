package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// TestEnsureBucket_Integration exercises EnsureBucket + Save/Get/Delete against a
// live S3-compatible endpoint. Skipped unless STORAGE_S3_TEST_ENDPOINT is set, e.g.
//
//	STORAGE_S3_TEST_ENDPOINT=http://localhost:9000 \
//	STORAGE_S3_TEST_ACCESS_KEY=minioadmin STORAGE_S3_TEST_SECRET_KEY=minioadmin123 \
//	go test ./internal/storage/ -run Integration -v
func TestEnsureBucket_Integration(t *testing.T) {
	endpoint := os.Getenv("STORAGE_S3_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("STORAGE_S3_TEST_ENDPOINT not set")
	}
	accessKey := os.Getenv("STORAGE_S3_TEST_ACCESS_KEY")
	secretKey := os.Getenv("STORAGE_S3_TEST_SECRET_KEY")
	if accessKey == "" || secretKey == "" {
		t.Fatal("STORAGE_S3_TEST_ACCESS_KEY and STORAGE_S3_TEST_SECRET_KEY are required")
	}

	bucket := fmt.Sprintf("ensure-bucket-test-%d", time.Now().UnixNano())
	cfg := &StorageConfig{
		S3Endpoint:        endpoint,
		S3PublicEndpoint:  endpoint,
		S3Bucket:          bucket,
		S3Region:          "us-east-1",
		S3AccessKey:       accessKey,
		S3SecretKey:       secretKey,
		S3PresignedExpiry: 60,
	}

	st, err := NewS3Storage(cfg)
	if err != nil {
		t.Fatalf("NewS3Storage: %v", err)
	}
	ctx := context.Background()
	t.Cleanup(func() {
		_, _ = st.client.DeleteBucket(ctx, &s3.DeleteBucketInput{Bucket: aws.String(bucket)})
	})

	// First call: bucket does not exist yet -> created.
	created, err := st.EnsureBucket(ctx)
	if err != nil {
		t.Fatalf("EnsureBucket (first): %v", err)
	}
	if !created {
		t.Fatalf("expected bucket %q to be created on first call", bucket)
	}

	// Second call: idempotent, nothing to do.
	created, err = st.EnsureBucket(ctx)
	if err != nil {
		t.Fatalf("EnsureBucket (second): %v", err)
	}
	if created {
		t.Fatal("expected second EnsureBucket call to be a no-op")
	}

	// Round-trip an object through the freshly created bucket.
	payload := []byte("opaque ciphertext")
	meta, err := st.Save(bytes.NewReader(payload), "blob.bin", "application/octet-stream", int64(len(payload)))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !strings.HasPrefix(meta.URL, endpoint) {
		t.Errorf("presigned URL %q does not start with endpoint %q", meta.URL, endpoint)
	}
	rc, err := st.Get(meta.Key)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	got, err := io.ReadAll(rc)
	_ = rc.Close()
	if err != nil {
		t.Fatalf("read object: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("round-trip mismatch: got %q want %q", got, payload)
	}
	if err := st.Delete(meta.Key); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	// Wrong credentials must surface as an error, not be mistaken for "missing bucket".
	badCfg := *cfg
	badCfg.S3SecretKey = "definitely-wrong"
	bad, err := NewS3Storage(&badCfg)
	if err != nil {
		t.Fatalf("NewS3Storage (bad creds): %v", err)
	}
	if _, err := bad.EnsureBucket(ctx); err == nil {
		t.Fatal("expected EnsureBucket with wrong credentials to fail")
	}
}
