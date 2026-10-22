package services

import (
	"fmt"
	"testing"
	"time"
)

func newTestLoginLimiter() (*LoginLimiter, *time.Time) {
	clock := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	l := NewLoginLimiter()
	l.now = func() time.Time { return clock }
	return l, &clock
}

func mustAllow(t *testing.T, l *LoginLimiter, user, ip string) {
	t.Helper()
	if wait, ok := l.Allow(user, ip); !ok {
		t.Fatalf("Allow(%q, %q) blocked for %s, want allowed", user, ip, wait)
	}
}

func mustBlock(t *testing.T, l *LoginLimiter, user, ip string) time.Duration {
	t.Helper()
	wait, ok := l.Allow(user, ip)
	if ok {
		t.Fatalf("Allow(%q, %q) allowed, want blocked", user, ip)
	}
	if wait <= 0 {
		t.Fatalf("blocked with non-positive retryAfter %s", wait)
	}
	return wait
}

func TestLoginLimiter_UserLockoutAfterMaxFailures(t *testing.T) {
	l, _ := newTestLoginLimiter()
	for i := 1; i < loginUserMaxFailure; i++ {
		mustAllow(t, l, "alice", "10.0.0.1")
		if locked := l.RecordFailure("alice", "10.0.0.1"); locked {
			t.Fatalf("locked after %d failures, want %d", i, loginUserMaxFailure)
		}
	}
	if locked := l.RecordFailure("alice", "10.0.0.1"); !locked {
		t.Fatalf("expected lockout on failure #%d", loginUserMaxFailure)
	}
	wait := mustBlock(t, l, "alice", "10.0.0.1")
	if wait != loginLockout {
		t.Fatalf("retryAfter = %s, want %s", wait, loginLockout)
	}
	// Same account from another IP is blocked too; another account from the
	// same IP is not (IP window far from its own limit).
	mustBlock(t, l, "alice", "10.0.0.2")
	mustAllow(t, l, "bob", "10.0.0.1")
}

func TestLoginLimiter_UsernameIsCaseAndSpaceInsensitive(t *testing.T) {
	l, _ := newTestLoginLimiter()
	for i := 0; i < loginUserMaxFailure; i++ {
		l.RecordFailure("Alice ", "10.0.0.1")
	}
	mustBlock(t, l, "alice", "10.0.0.9")
	mustBlock(t, l, "ALICE", "10.0.0.9")
}

func TestLoginLimiter_IPLockoutAcrossUsernames(t *testing.T) {
	l, _ := newTestLoginLimiter()
	for i := 0; i < loginIPMaxFailure; i++ {
		l.RecordFailure(fmt.Sprintf("user%d", i), "203.0.113.5")
	}
	mustBlock(t, l, "somebody-new", "203.0.113.5")
	mustAllow(t, l, "somebody-new", "203.0.113.6")
}

func TestLoginLimiter_SuccessClearsUserButNotIP(t *testing.T) {
	l, _ := newTestLoginLimiter()
	for i := 0; i < loginUserMaxFailure-1; i++ {
		l.RecordFailure("alice", "10.0.0.1")
	}
	l.RecordSuccess("alice")
	// Window cleared: it takes a full set of failures to lock again.
	for i := 0; i < loginUserMaxFailure-1; i++ {
		l.RecordFailure("alice", "10.0.0.1")
	}
	mustAllow(t, l, "alice", "10.0.0.1")

	// IP failures accumulated through all of that and keep counting.
	for i := 0; i < loginIPMaxFailure-2*(loginUserMaxFailure-1); i++ {
		l.RecordFailure(fmt.Sprintf("other%d", i), "10.0.0.1")
	}
	mustBlock(t, l, "whoever", "10.0.0.1")
}

func TestLoginLimiter_LockoutAndWindowExpire(t *testing.T) {
	l, clock := newTestLoginLimiter()
	for i := 0; i < loginUserMaxFailure; i++ {
		l.RecordFailure("alice", "10.0.0.1")
	}
	*clock = clock.Add(loginLockout - time.Second)
	mustBlock(t, l, "alice", "10.0.0.1")
	*clock = clock.Add(2 * time.Second)
	mustAllow(t, l, "alice", "10.0.0.1")

	// Failures spread wider than the window never add up to a lockout.
	for i := 0; i < 3*loginUserMaxFailure; i++ {
		l.RecordFailure("carol", "10.0.0.3")
		*clock = clock.Add(loginWindow/2 + time.Second)
		mustAllow(t, l, "carol", "10.0.0.3")
	}
}

func TestLoginLimiter_SweepDropsStaleBuckets(t *testing.T) {
	l, clock := newTestLoginLimiter()
	for i := 0; i < loginSweepEvery-1; i++ {
		l.RecordFailure(fmt.Sprintf("u%d", i), fmt.Sprintf("10.1.%d.%d", i/256, i%256))
	}
	if len(l.byUser) == 0 {
		t.Fatal("expected buckets before sweep")
	}
	*clock = clock.Add(loginWindow + loginLockout + time.Minute)
	l.RecordSuccess("trigger") // the N-th mutation runs the sweep
	if len(l.byUser) != 0 || len(l.byIP) != 0 {
		t.Fatalf("buckets after sweep: users=%d ips=%d, want 0/0", len(l.byUser), len(l.byIP))
	}
}
