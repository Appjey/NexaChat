package services

import (
	"strings"
	"sync"
	"time"
)

// Login throttling policy. Two independent sliding windows, both counting
// only *failed* attempts:
//
//   - per username: a credential-stuffing or dictionary attack on one account
//     is cut off after loginUserMaxFailures misses, regardless of how many IPs
//     it comes from;
//   - per client IP: a spray across many usernames from one address is cut off
//     after loginIPMaxFailures misses.
//
// Hitting either limit locks that key for loginLockout; a successful login
// clears the username's window (but not the IP's, so a spray that happens to
// guess one account right keeps being throttled).
const (
	loginWindow         = 15 * time.Minute
	loginLockout        = 15 * time.Minute
	loginUserMaxFailure = 5
	loginIPMaxFailure   = 30
	// loginSweepEvery bounds the map size: every N mutations stale buckets
	// (no failures inside the window, no active lockout) are dropped.
	loginSweepEvery = 256
)

type loginBucket struct {
	failures    []time.Time
	lockedUntil time.Time
}

// LoginLimiter throttles credential guessing on the login endpoint. In-memory
// and per-process, like the HTTP rate limiter — adequate for the single
// backend instance this deployment runs.
type LoginLimiter struct {
	mu     sync.Mutex
	now    func() time.Time
	byUser map[string]*loginBucket
	byIP   map[string]*loginBucket
	ops    int
}

// NewLoginLimiter creates a limiter with the package policy above.
func NewLoginLimiter() *LoginLimiter {
	return &LoginLimiter{
		now:    time.Now,
		byUser: make(map[string]*loginBucket),
		byIP:   make(map[string]*loginBucket),
	}
}

func normalizeLoginUser(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// Allow reports whether a login attempt for username from ip may proceed.
// When it may not, retryAfter is how long the caller should wait (for the
// Retry-After header).
func (l *LoginLimiter) Allow(username, ip string) (retryAfter time.Duration, ok bool) {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()

	var wait time.Duration
	for _, b := range []*loginBucket{l.byUser[normalizeLoginUser(username)], l.byIP[ip]} {
		if b == nil {
			continue
		}
		if remaining := b.lockedUntil.Sub(now); remaining > 0 && remaining > wait {
			wait = remaining
		}
	}
	if wait > 0 {
		return wait, false
	}
	return 0, true
}

// RecordFailure registers a failed attempt and starts a lockout when a window
// overflows. Returns true if this failure triggered (or extended) a lockout —
// callers use it to log the event once rather than on every rejected request.
func (l *LoginLimiter) RecordFailure(username, ip string) bool {
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.maybeSweep(now)

	locked := l.bucket(l.byUser, normalizeLoginUser(username)).fail(now, loginUserMaxFailure)
	if l.bucket(l.byIP, ip).fail(now, loginIPMaxFailure) {
		locked = true
	}
	return locked
}

// RecordSuccess clears the username's failure window. The IP window is left
// alone on purpose (see the policy comment at the top).
func (l *LoginLimiter) RecordSuccess(username string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.maybeSweep(l.now())
	delete(l.byUser, normalizeLoginUser(username))
}

func (l *LoginLimiter) bucket(m map[string]*loginBucket, key string) *loginBucket {
	b, ok := m[key]
	if !ok {
		b = &loginBucket{}
		m[key] = b
	}
	return b
}

// fail appends a failure, drops ones older than the window and locks the
// bucket when the window holds max or more failures.
func (b *loginBucket) fail(now time.Time, maxFailures int) bool {
	b.prune(now)
	b.failures = append(b.failures, now)
	if len(b.failures) >= maxFailures {
		b.lockedUntil = now.Add(loginLockout)
		b.failures = b.failures[:0]
		return true
	}
	return false
}

func (b *loginBucket) prune(now time.Time) {
	cutoff := now.Add(-loginWindow)
	i := 0
	for i < len(b.failures) && b.failures[i].Before(cutoff) {
		i++
	}
	if i > 0 {
		b.failures = append(b.failures[:0], b.failures[i:]...)
	}
}

func (b *loginBucket) stale(now time.Time) bool {
	b.prune(now)
	return len(b.failures) == 0 && !now.Before(b.lockedUntil)
}

// maybeSweep drops buckets that carry no state any more. Called with l.mu held.
func (l *LoginLimiter) maybeSweep(now time.Time) {
	l.ops++
	if l.ops%loginSweepEvery != 0 {
		return
	}
	for _, m := range []map[string]*loginBucket{l.byUser, l.byIP} {
		for k, b := range m {
			if b.stale(now) {
				delete(m, k)
			}
		}
	}
}
