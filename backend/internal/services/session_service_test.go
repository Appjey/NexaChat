package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"messenger/internal/models"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// fakeSessionStore is an in-memory sessionStore that also counts reads so the
// cache behavior can be asserted.
type fakeSessionStore struct {
	rows   map[uint]*models.Session
	nextID uint
	finds  int
}

func newFakeSessionStore() *fakeSessionStore {
	return &fakeSessionStore{rows: make(map[uint]*models.Session), nextID: 1}
}

func (f *fakeSessionStore) Create(_ context.Context, s *models.Session) error {
	s.ID = f.nextID
	f.nextID++
	copyRow := *s
	f.rows[s.ID] = &copyRow
	return nil
}

func (f *fakeSessionStore) FindByID(_ context.Context, id uint) (*models.Session, error) {
	f.finds++
	row, ok := f.rows[id]
	if !ok {
		return nil, gorm.ErrRecordNotFound
	}
	copyRow := *row
	return &copyRow, nil
}

func (f *fakeSessionStore) Revoke(_ context.Context, sessionID, userID uint, at time.Time) error {
	row, ok := f.rows[sessionID]
	if ok && row.UserID == userID && row.RevokedAt == nil {
		row.RevokedAt = &at
	}
	return nil
}

func (f *fakeSessionStore) RevokeAllExcept(_ context.Context, userID, keepID uint, at time.Time) error {
	for id, row := range f.rows {
		if row.UserID == userID && id != keepID && row.RevokedAt == nil {
			row.RevokedAt = &at
		}
	}
	return nil
}

func newTestSessionService(store sessionStore) *SessionService {
	svc := NewSessionService(zap.NewNop(), store)
	return svc
}

func TestSessionService_CreateAndValidate(t *testing.T) {
	ctx := context.Background()
	store := newFakeSessionStore()
	svc := newTestSessionService(store)

	sid, err := svc.Create(ctx, 7)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if sid == 0 {
		t.Fatal("expected non-zero session id")
	}
	if err := svc.Validate(ctx, sid, 7); err != nil {
		t.Fatalf("Validate(own session) = %v, want nil", err)
	}
	if err := svc.Validate(ctx, sid, 8); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("Validate(other user) = %v, want ErrSessionRevoked", err)
	}
	if err := svc.Validate(ctx, 999, 7); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("Validate(unknown id) = %v, want ErrSessionRevoked", err)
	}
	if err := svc.Validate(ctx, 0, 7); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("Validate(zero id) = %v, want ErrSessionRevoked", err)
	}
}

func TestSessionService_ValidateUsesCache(t *testing.T) {
	ctx := context.Background()
	store := newFakeSessionStore()
	svc := newTestSessionService(store)
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return clock }

	sid, _ := svc.Create(ctx, 1)
	for i := 0; i < 5; i++ {
		if err := svc.Validate(ctx, sid, 1); err != nil {
			t.Fatalf("Validate #%d: %v", i, err)
		}
	}
	if store.finds != 1 {
		t.Fatalf("store reads = %d, want 1 (cached)", store.finds)
	}

	// Past the TTL the verdict is re-read from the store.
	clock = clock.Add(sessionCacheTTL + time.Second)
	if err := svc.Validate(ctx, sid, 1); err != nil {
		t.Fatalf("Validate after ttl: %v", err)
	}
	if store.finds != 2 {
		t.Fatalf("store reads = %d, want 2 after cache expiry", store.finds)
	}
}

func TestSessionService_RevokeIsImmediate(t *testing.T) {
	ctx := context.Background()
	store := newFakeSessionStore()
	svc := newTestSessionService(store)

	sid, _ := svc.Create(ctx, 1)
	if err := svc.Validate(ctx, sid, 1); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if err := svc.Revoke(ctx, sid, 1); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	// Cached positive verdict must not survive the revocation.
	if err := svc.Validate(ctx, sid, 1); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("Validate after revoke = %v, want ErrSessionRevoked", err)
	}
}

func TestSessionService_RevokeScopedToOwner(t *testing.T) {
	ctx := context.Background()
	store := newFakeSessionStore()
	svc := newTestSessionService(store)

	sid, _ := svc.Create(ctx, 1)
	// User 2 tries to revoke user 1's session by id.
	if err := svc.Revoke(ctx, sid, 2); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := svc.Validate(ctx, sid, 1); err != nil {
		t.Fatalf("session must survive a foreign revoke, got %v", err)
	}
}

func TestSessionService_RevokeOthersKeepsCurrent(t *testing.T) {
	ctx := context.Background()
	store := newFakeSessionStore()
	svc := newTestSessionService(store)

	phone, _ := svc.Create(ctx, 1)
	laptop, _ := svc.Create(ctx, 1)
	stranger, _ := svc.Create(ctx, 2)
	for _, sid := range []uint{phone, laptop} {
		if err := svc.Validate(ctx, sid, 1); err != nil {
			t.Fatalf("warm cache for %d: %v", sid, err)
		}
	}
	if err := svc.Validate(ctx, stranger, 2); err != nil {
		t.Fatalf("warm cache for stranger: %v", err)
	}

	if err := svc.RevokeOthers(ctx, 1, phone); err != nil {
		t.Fatalf("RevokeOthers: %v", err)
	}
	if err := svc.Validate(ctx, phone, 1); err != nil {
		t.Fatalf("kept session rejected: %v", err)
	}
	if err := svc.Validate(ctx, laptop, 1); !errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("other session = %v, want ErrSessionRevoked", err)
	}
	if err := svc.Validate(ctx, stranger, 2); err != nil {
		t.Fatalf("another user's session must be untouched, got %v", err)
	}
}

func TestSessionService_StoreErrorIsNotRevoked(t *testing.T) {
	ctx := context.Background()
	svc := newTestSessionService(failingSessionStore{})
	err := svc.Validate(ctx, 1, 1)
	if err == nil || errors.Is(err, ErrSessionRevoked) {
		t.Fatalf("Validate = %v, want a non-revoked store error", err)
	}
}

type failingSessionStore struct{}

var errStoreDown = errors.New("store down")

func (failingSessionStore) Create(context.Context, *models.Session) error { return errStoreDown }
func (failingSessionStore) FindByID(context.Context, uint) (*models.Session, error) {
	return nil, errStoreDown
}
func (failingSessionStore) Revoke(context.Context, uint, uint, time.Time) error { return errStoreDown }
func (failingSessionStore) RevokeAllExcept(context.Context, uint, uint, time.Time) error {
	return errStoreDown
}
