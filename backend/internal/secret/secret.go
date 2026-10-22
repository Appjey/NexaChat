// Package secret provides helpers for loading secret values that may be supplied
// either directly via environment variables or — under the Docker Compose secrets
// pattern — via a file path in `${name}_FILE`.
package secret

import (
	"fmt"
	"os"
	"strings"
)

// ReadEnvOrFile resolves a secret value following the Docker secrets convention:
//
//   - if `${name}` is set in the environment, it wins (operator override path)
//   - otherwise, if `${name}_FILE` is set, the contents of that file are returned
//     (with trailing CR/LF trimmed, which is the typical artifact of
//     `echo "value" > /run/secrets/...`)
//
// Empty string + nil error is returned when neither is set, leaving absence-checks
// to the caller (some secrets are required, others optional).
//
// Used by both internal/config (DB_URL, JWT_SECRET, etc.) and internal/storage
// (S3 credentials). Lives in its own package to avoid an import cycle between
// the two.
func ReadEnvOrFile(name string) (string, error) {
	if v := os.Getenv(name); v != "" {
		return v, nil
	}
	path := os.Getenv(name + "_FILE")
	if path == "" {
		return "", nil
	}
	// G304: path is read from an env var set by the operator at deploy time, not from
	// untrusted input. Suppressing both gosec rule and the golangci wrapper to be safe.
	data, err := os.ReadFile(path) // #nosec G304 G703 -- operator-controlled config path
	if err != nil {
		return "", fmt.Errorf("read %s_FILE: %w", name, err)
	}
	return strings.TrimRight(string(data), "\r\n"), nil
}
