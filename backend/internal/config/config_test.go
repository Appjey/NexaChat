package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// writeSecretFile creates a temp file with the given content and returns its path.
// Used to exercise the `*_FILE` Docker secrets convention.
func writeSecretFile(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write secret file: %v", err)
	}
	return path
}

func TestLoadConfig_Valid(t *testing.T) {
	t.Setenv("DB_URL", "postgres://user:pass@localhost:5432/testdb")
	t.Setenv("JWT_SECRET", "this-is-a-very-secure-secret-key-32+")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.DBURL != "postgres://user:pass@localhost:5432/testdb" {
		t.Errorf("DBURL = %q, want postgres://...", cfg.DBURL)
	}
	if cfg.JWTSecret != "this-is-a-very-secure-secret-key-32+" {
		t.Errorf("JWTSecret mismatch")
	}
}

func TestLoadConfig_MissingDBURL(t *testing.T) {
	t.Setenv("DB_URL", "")
	t.Setenv("JWT_SECRET", "this-is-a-very-secure-secret-key-32+")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for missing DB_URL")
	}
	if !errors.Is(err, errDBURLNotSet) {
		t.Errorf("expected errDBURLNotSet, got: %v", err)
	}
}

func TestLoadConfig_MissingJWTSecret(t *testing.T) {
	t.Setenv("DB_URL", "postgres://user:pass@localhost:5432/testdb")
	t.Setenv("JWT_SECRET", "")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for missing JWT_SECRET")
	}
	if !errors.Is(err, errJWTSecretNotSet) {
		t.Errorf("expected errJWTSecretNotSet, got: %v", err)
	}
}

func TestLoadConfig_ShortJWTSecret(t *testing.T) {
	t.Setenv("DB_URL", "postgres://user:pass@localhost:5432/testdb")
	t.Setenv("JWT_SECRET", "too-short")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error for short JWT_SECRET")
	}
	if !errors.Is(err, errJWTSecretTooShort) {
		t.Errorf("expected errJWTSecretTooShort, got: %v", err)
	}
}

func TestLoadConfig_VAPIDKeysOptional(t *testing.T) {
	t.Setenv("DB_URL", "postgres://user:pass@localhost:5432/testdb")
	t.Setenv("JWT_SECRET", "this-is-a-very-secure-secret-key-32+")
	t.Setenv("VAPID_PUBLIC_KEY", "")
	t.Setenv("VAPID_PRIVATE_KEY", "")
	t.Setenv("VAPID_SUBJECT", "")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() should not error when VAPID keys absent: %v", err)
	}
	if cfg.VAPIDPublicKey != "" {
		t.Error("VAPIDPublicKey should be empty")
	}
}

func TestLoadConfig_JWTSecretExactly32Chars(t *testing.T) {
	t.Setenv("DB_URL", "postgres://user:pass@localhost:5432/testdb")
	t.Setenv("JWT_SECRET", "abcdefghijklmnopqrstuvwxyz123456") // exactly 32

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() should accept 32-char secret: %v", err)
	}
	if cfg.JWTSecret != "abcdefghijklmnopqrstuvwxyz123456" {
		t.Error("JWTSecret mismatch")
	}
}

// TestLoadConfig_FileVariant verifies the Docker-secrets-style *_FILE fallback —
// when the plain env var is empty but `*_FILE` points to a readable file, the file's
// contents are used instead. This is what makes the backend compatible with the
// `secrets:` block in docker-compose without rewriting deploy logic.
func TestLoadConfig_FileVariant(t *testing.T) {
	// Clear the direct env vars so the *_FILE fallback kicks in.
	t.Setenv("DB_URL", "")
	t.Setenv("JWT_SECRET", "")
	t.Setenv("VAPID_PRIVATE_KEY", "")

	dbURLPath := writeSecretFile(t, "db_url", "postgres://user:pass@localhost:5432/testdb\n") // trailing newline on purpose
	jwtPath := writeSecretFile(t, "jwt_secret", "this-is-a-very-secure-secret-key-32+")
	vapidPath := writeSecretFile(t, "vapid_private_key", "vapid-private-key-content")

	t.Setenv("DB_URL_FILE", dbURLPath)
	t.Setenv("JWT_SECRET_FILE", jwtPath)
	t.Setenv("VAPID_PRIVATE_KEY_FILE", vapidPath)

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.DBURL != "postgres://user:pass@localhost:5432/testdb" {
		t.Errorf("DBURL = %q (trailing newline not stripped?)", cfg.DBURL)
	}
	if cfg.JWTSecret != "this-is-a-very-secure-secret-key-32+" {
		t.Errorf("JWTSecret = %q", cfg.JWTSecret)
	}
	if cfg.VAPIDPrivateKey != "vapid-private-key-content" {
		t.Errorf("VAPIDPrivateKey = %q", cfg.VAPIDPrivateKey)
	}
}

// TestLoadConfig_FileVariantMissing — if `*_FILE` points at a missing path, the error
// is surfaced rather than silently treating the secret as empty.
func TestLoadConfig_FileVariantMissing(t *testing.T) {
	t.Setenv("DB_URL", "")
	t.Setenv("DB_URL_FILE", "/nonexistent/path/db_url")
	t.Setenv("JWT_SECRET", "this-is-a-very-secure-secret-key-32+")

	_, err := LoadConfig()
	if err == nil {
		t.Fatal("expected error when *_FILE path is unreadable")
	}
}

// TestLoadConfig_DirectEnvWins — if both `${name}` and `${name}_FILE` are set, the
// direct env value wins. Documents intentional precedence (env > file) so an operator
// can override a deployed secret quickly without touching the secret file.
func TestLoadConfig_DirectEnvWins(t *testing.T) {
	jwtPath := writeSecretFile(t, "jwt_secret", "from-file-this-should-be-overridden-32+")
	t.Setenv("DB_URL", "postgres://user:pass@localhost:5432/testdb")
	t.Setenv("JWT_SECRET", "from-env-this-wins-and-is-32-chars+")
	t.Setenv("JWT_SECRET_FILE", jwtPath)

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig() error = %v", err)
	}
	if cfg.JWTSecret != "from-env-this-wins-and-is-32-chars+" {
		t.Errorf("expected env value to take precedence, got: %q", cfg.JWTSecret)
	}
}

func TestLoadConfig_OriginAndProxyDefaults(t *testing.T) {
	t.Setenv("DB_URL", "postgres://user:pass@localhost:5432/testdb")
	t.Setenv("JWT_SECRET", "this-is-a-very-secure-secret-key-32+")
	t.Setenv("ALLOWED_ORIGINS", "")
	t.Setenv("TRUSTED_PROXIES", "")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cfg.AllowedOrigins) == 0 {
		t.Fatal("expected default allowed origins")
	}
	if cfg.AllowedOrigins[len(cfg.AllowedOrigins)-1] != "https://localhost" {
		t.Fatalf("expected https://localhost in defaults, got %v", cfg.AllowedOrigins)
	}
	if len(cfg.TrustedProxies) == 0 {
		t.Fatal("expected default trusted proxies")
	}
	for _, cidr := range cfg.TrustedProxies {
		if cidr == "0.0.0.0/0" {
			t.Fatal("defaults must not trust every proxy")
		}
	}
}

func TestLoadConfig_OriginAndProxyOverride(t *testing.T) {
	t.Setenv("DB_URL", "postgres://user:pass@localhost:5432/testdb")
	t.Setenv("JWT_SECRET", "this-is-a-very-secure-secret-key-32+")
	t.Setenv("ALLOWED_ORIGINS", " https://a.example , https://b.example,, ")
	t.Setenv("TRUSTED_PROXIES", "203.0.113.5, 10.1.0.0/16")

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	wantOrigins := []string{"https://a.example", "https://b.example"}
	if len(cfg.AllowedOrigins) != len(wantOrigins) {
		t.Fatalf("origins = %v, want %v", cfg.AllowedOrigins, wantOrigins)
	}
	for i := range wantOrigins {
		if cfg.AllowedOrigins[i] != wantOrigins[i] {
			t.Fatalf("origins = %v, want %v", cfg.AllowedOrigins, wantOrigins)
		}
	}
	wantProxies := []string{"203.0.113.5", "10.1.0.0/16"}
	if len(cfg.TrustedProxies) != len(wantProxies) {
		t.Fatalf("proxies = %v, want %v", cfg.TrustedProxies, wantProxies)
	}
	for i := range wantProxies {
		if cfg.TrustedProxies[i] != wantProxies[i] {
			t.Fatalf("proxies = %v, want %v", cfg.TrustedProxies, wantProxies)
		}
	}
}
