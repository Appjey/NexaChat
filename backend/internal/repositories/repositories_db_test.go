package repositories

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"messenger/internal/models"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// testDB returns a GORM handle on a fresh, private Postgres schema that is
// dropped when the test ends. Skips when DB_URL is unset, so `go test ./...`
// stays runnable without a database; CI (and the docker compose stack) sets
// it. The schema name rides in the DSN's search_path so every pooled
// connection sees it.
func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := os.Getenv("DB_URL")
	if dsn == "" {
		t.Skip("DB_URL not set")
	}
	schema := fmt.Sprintf("t_%d", time.Now().UnixNano())

	admin, err := gorm.Open(postgres.Open(dsn), &gorm.Config{Logger: logger.Discard})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if err := admin.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		t.Fatalf("create schema: %v", err)
	}

	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	// Same migrator settings as internal/app: no FK constraints, so tests can
	// insert rows in isolation exactly as the production schema allows.
	db, err := gorm.Open(postgres.Open(dsn+sep+"search_path="+schema), &gorm.Config{
		Logger:                                   logger.Discard,
		DisableForeignKeyConstraintWhenMigrating: true,
	})
	if err != nil {
		t.Fatalf("connect to schema: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
		_ = admin.Exec("DROP SCHEMA " + schema + " CASCADE").Error
		if sqlDB, err := admin.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	if err := db.AutoMigrate(
		&models.User{}, &models.Chat{}, &models.Message{}, &models.MessageEnvelope{},
		&models.Contact{}, &models.Attachment{}, &models.AttachmentEnvelope{},
		&models.UnreadMessage{}, &models.MessageReceipt{}, &models.PushSubscription{},
		&models.ChatParticipant{}, &models.PinnedMessage{}, &models.FCMToken{},
		&models.AppRelease{}, &models.Session{},
		&models.UserPreference{}, &models.UserChatPreference{},
	); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func mustCreateUser(t *testing.T, repo *UserRepo, username string) *models.User {
	t.Helper()
	u := &models.User{Username: username, Password: "x", Name: strings.ToUpper(username)}
	if err := repo.Create(context.Background(), u); err != nil {
		t.Fatalf("create user %s: %v", username, err)
	}
	return u
}

func uintPtr(v uint) *uint { return &v }

// ---------- sessions ----------

func TestSessionRepo_Lifecycle(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	repo := NewSessionRepo(db)

	phone := &models.Session{UserID: 1}
	laptop := &models.Session{UserID: 1}
	other := &models.Session{UserID: 2}
	for _, s := range []*models.Session{phone, laptop, other} {
		if err := repo.Create(ctx, s); err != nil {
			t.Fatalf("create: %v", err)
		}
	}

	got, err := repo.FindByID(ctx, phone.ID)
	if err != nil || !got.IsActive() || got.UserID != 1 {
		t.Fatalf("FindByID = %+v, %v", got, err)
	}
	if _, err := repo.FindByID(ctx, 999999); err == nil {
		t.Fatal("expected not found for unknown id")
	}

	// Revoke is scoped by owner: user 2 cannot revoke user 1's session.
	if err := repo.Revoke(ctx, phone.ID, 2, time.Now()); err != nil {
		t.Fatalf("foreign revoke: %v", err)
	}
	if after, _ := repo.FindByID(ctx, phone.ID); !after.IsActive() {
		t.Fatal("foreign revoke must not take effect")
	}

	if err := repo.Revoke(ctx, phone.ID, 1, time.Now()); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if after, _ := repo.FindByID(ctx, phone.ID); after.IsActive() {
		t.Fatal("phone session still active after revoke")
	}

	// Password change: everything of user 1 except the laptop goes.
	extra := &models.Session{UserID: 1}
	_ = repo.Create(ctx, extra)
	if err := repo.RevokeAllExcept(ctx, 1, laptop.ID, time.Now()); err != nil {
		t.Fatalf("revoke all except: %v", err)
	}
	l, _ := repo.FindByID(ctx, laptop.ID)
	e, _ := repo.FindByID(ctx, extra.ID)
	o, _ := repo.FindByID(ctx, other.ID)
	if !l.IsActive() || e.IsActive() || !o.IsActive() {
		t.Fatalf("after RevokeAllExcept: laptop=%v extra=%v other=%v", l.IsActive(), e.IsActive(), o.IsActive())
	}
}

// ---------- users ----------

func TestUserRepo_UniqueUsernameAndVault(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	repo := NewUserRepo(db)

	alice := mustCreateUser(t, repo, "alice")
	if err := repo.Create(ctx, &models.User{Username: "alice", Password: "x", Name: "Dup"}); err == nil {
		t.Fatal("duplicate username must fail")
	}

	found, err := repo.FindByUsername(ctx, "alice")
	if err != nil || found.ID != alice.ID {
		t.Fatalf("FindByUsername = %+v, %v", found, err)
	}

	if err := repo.UpdateVault(ctx, alice.ID, "salt", "wrapped", "pub"); err != nil {
		t.Fatalf("UpdateVault: %v", err)
	}
	found, _ = repo.FindByID(ctx, alice.ID)
	if found.VaultSalt == nil || *found.VaultSalt != "salt" || found.PublicKey == nil || *found.PublicKey != "pub" {
		t.Fatalf("vault not persisted: %+v", found)
	}
	// Opt-out clears all three.
	if err := repo.UpdateVault(ctx, alice.ID, "", "", ""); err != nil {
		t.Fatalf("UpdateVault clear: %v", err)
	}
	found, _ = repo.FindByID(ctx, alice.ID)
	if found.VaultSalt != nil || found.EncryptedAccountKey != nil || found.PublicKey != nil {
		t.Fatalf("vault not cleared: %+v", found)
	}
}

func TestUserRepo_Search(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	repo := NewUserRepo(db)

	me := mustCreateUser(t, repo, "me")
	ivan := &models.User{Username: "ivanov", Password: "x", Name: "Иван Иванов"}
	petr := &models.User{Username: "petrov", Password: "x", Name: "Пётр Петров"}
	for _, u := range []*models.User{ivan, petr} {
		if err := repo.Create(ctx, u); err != nil {
			t.Fatalf("create: %v", err)
		}
	}

	cases := []struct {
		query string
		want  []uint
	}{
		{"@ivanov", []uint{ivan.ID}},
		{"Иванов Иван", []uint{ivan.ID}}, // tokens AND-ed, order-independent
		{"ov", []uint{ivan.ID, petr.ID}},
		{"me", []uint{}}, // caller excluded
		{"   ", []uint{}},
	}
	for _, tc := range cases {
		got, err := repo.SearchByUsernameOrName(ctx, tc.query, me.ID)
		if err != nil {
			t.Fatalf("search %q: %v", tc.query, err)
		}
		ids := map[uint]bool{}
		for _, u := range got {
			ids[u.ID] = true
		}
		if len(ids) != len(tc.want) {
			t.Fatalf("search %q: got %d users, want %d", tc.query, len(ids), len(tc.want))
		}
		for _, id := range tc.want {
			if !ids[id] {
				t.Fatalf("search %q: missing user %d", tc.query, id)
			}
		}
	}
}

// ---------- chats ----------

func TestChatRepo_DirectChatNormalisation(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	users := NewUserRepo(db)
	chats := NewChatRepo(db)
	a := mustCreateUser(t, users, "a")
	b := mustCreateUser(t, users, "b")

	chat := &models.Chat{User1ID: uintPtr(b.ID), User2ID: uintPtr(a.ID)}
	if err := chats.Create(ctx, chat); err != nil {
		t.Fatalf("create chat: %v", err)
	}
	if chat.GetUser1ID() != a.ID || chat.GetUser2ID() != b.ID {
		t.Fatalf("BeforeCreate must order ids ascending, got %d/%d", chat.GetUser1ID(), chat.GetUser2ID())
	}
	// Second chat for the same pair violates the unique index.
	if err := chats.Create(ctx, &models.Chat{User1ID: uintPtr(a.ID), User2ID: uintPtr(b.ID)}); err == nil {
		t.Fatal("duplicate 1-on-1 chat must fail")
	}
	for _, pair := range [][2]uint{{a.ID, b.ID}, {b.ID, a.ID}} {
		found, err := chats.FindByUsers(ctx, pair[0], pair[1])
		if err != nil || found.ID != chat.ID {
			t.Fatalf("FindByUsers(%v) = %+v, %v", pair, found, err)
		}
	}
	// Self-chat (Saved Messages) is a distinct row.
	self := &models.Chat{User1ID: uintPtr(a.ID), User2ID: uintPtr(a.ID)}
	if err := chats.Create(ctx, self); err != nil {
		t.Fatalf("create self chat: %v", err)
	}

	list, err := chats.GetUserChatsIncludingGroups(ctx, a.ID, nil, false)
	if err != nil || len(list) != 2 {
		t.Fatalf("GetUserChatsIncludingGroups = %d chats, %v", len(list), err)
	}
}

// ---------- messages ----------

func TestMessageRepo_RecentAndSoftDelete(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	repo := NewMessageRepo(db)

	for i := 1; i <= 5; i++ {
		m := &models.Message{ChatID: 1, UserID: 1, Text: fmt.Sprintf("ct%d", i), IV: "iv", Scheme: models.SchemeClientSide}
		if err := repo.Create(ctx, m); err != nil {
			t.Fatalf("create: %v", err)
		}
		time.Sleep(2 * time.Millisecond) // distinct created_at
	}

	recent, err := repo.GetRecentByChatID(ctx, 1, 3)
	if err != nil || len(recent) != 3 {
		t.Fatalf("GetRecentByChatID = %d, %v", len(recent), err)
	}
	if recent[0].Text != "ct3" || recent[2].Text != "ct5" {
		t.Fatalf("expected chronological order of the newest 3, got %s..%s", recent[0].Text, recent[2].Text)
	}

	last, err := repo.GetLastNonDeletedByChatID(ctx, 1)
	if err != nil || last.Text != "ct5" {
		t.Fatalf("last = %+v, %v", last, err)
	}
	if err := repo.SoftDeleteMessage(ctx, last.ID); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	deleted, _ := repo.FindByID(ctx, last.ID)
	if !deleted.IsDeleted || deleted.Text != "" || deleted.IV != "" {
		t.Fatalf("soft delete must wipe text+iv: %+v", deleted)
	}
	last, _ = repo.GetLastNonDeletedByChatID(ctx, 1)
	if last.Text != "ct4" {
		t.Fatalf("preview must skip deleted, got %s", last.Text)
	}
	if _, err := repo.GetLastNonDeletedByChatID(ctx, 42); err == nil {
		t.Fatal("empty chat must return an error (not found)")
	}
}

// ---------- unread ----------

func TestUnreadMessageRepo_CountsAndDrain(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	repo := NewUnreadMessageRepo(db)

	rows := []models.UnreadMessage{
		{UserID: 7, ChatID: 1, MessageID: 10},
		{UserID: 7, ChatID: 1, MessageID: 11},
		{UserID: 7, ChatID: 2, MessageID: 12},
		{UserID: 8, ChatID: 1, MessageID: 10},
	}
	for i := range rows {
		if err := repo.Create(ctx, &rows[i]); err != nil {
			t.Fatalf("create: %v", err)
		}
	}
	counts, err := repo.GetUnreadCounts(ctx, 7)
	if err != nil || counts[1] != 2 || counts[2] != 1 {
		t.Fatalf("counts = %v, %v", counts, err)
	}
	if has, _ := repo.HasUnreadInChat(ctx, 7, 1); !has {
		t.Fatal("expected unread in chat 1")
	}
	if err := repo.DeleteByChat(ctx, 7, 1); err != nil {
		t.Fatalf("DeleteByChat: %v", err)
	}
	if has, _ := repo.HasUnreadInChat(ctx, 7, 1); has {
		t.Fatal("chat 1 should be drained for user 7")
	}
	if has, _ := repo.HasUnreadInChat(ctx, 8, 1); !has {
		t.Fatal("user 8 must be untouched")
	}
	if err := repo.DeleteByUser(ctx, 7); err != nil {
		t.Fatalf("DeleteByUser: %v", err)
	}
	counts, _ = repo.GetUnreadCounts(ctx, 7)
	if len(counts) != 0 {
		t.Fatalf("expected no unread for user 7, got %v", counts)
	}
}

// ---------- preferences ----------

func TestPreferenceRepo_AccountAndChatCAS(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	repo := NewPreferenceRepo(db)

	pref := models.DefaultUserPreference(101)
	pref.ThemeID = "ocean"
	pref.LastIdempotencyKey = "idem-acc-1"

	saved, err := repo.UpsertAccountPrefCAS(ctx, pref, 0)
	if err != nil {
		t.Fatalf("UpsertAccountPrefCAS initial: %v", err)
	}
	if saved.Version != 1 || saved.ThemeID != "ocean" {
		t.Fatalf("unexpected saved account pref: %+v", saved)
	}

	// Idempotent retry with same key and expectedVersion=0
	retry, err := repo.UpsertAccountPrefCAS(ctx, pref, 0)
	if err != nil || retry.Version != 1 {
		t.Fatalf("idempotent retry failed: err=%v ver=%d", err, retry.Version)
	}

	// Conflict with stale expectedVersion=0 and new key
	prefConflict := *saved
	prefConflict.ThemeID = "forest"
	prefConflict.LastIdempotencyKey = "idem-acc-2"
	current, err := repo.UpsertAccountPrefCAS(ctx, &prefConflict, 0)
	if !errors.Is(err, ErrPreferenceVersionConflict) || current == nil || current.ThemeID != "ocean" {
		t.Fatalf("expected conflict with current ocean, got err=%v cur=%+v", err, current)
	}

	// Per-chat CAS + DeleteByChat
	chatPref, err := repo.UpsertChatPrefCAS(ctx, 101, 55, 0, "chat-idem-1", func(cur *models.UserChatPreference) {
		cur.WallpaperMode = models.PrefModeNone
	})
	if err != nil || chatPref.Version != 1 || chatPref.WallpaperMode != models.PrefModeNone {
		t.Fatalf("UpsertChatPrefCAS failed: err=%v pref=%+v", err, chatPref)
	}

	if err := repo.DeleteByChat(ctx, 55); err != nil {
		t.Fatalf("DeleteByChat: %v", err)
	}
	list, err := repo.ListChatPrefs(ctx, 101)
	if err != nil || len(list) != 0 {
		t.Fatalf("expected empty chat prefs after DeleteByChat, got %v, %v", list, err)
	}
}
