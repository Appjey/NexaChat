package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"messenger/internal/app"
)

func main() {
	// Health check flag for Docker healthcheck in distroless containers.
	if len(os.Args) > 1 && os.Args[1] == "-health" {
		os.Exit(runHealthCheck())
	}

	if err := app.Run(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "server failed: %v\n", err)
		os.Exit(1)
	}
}

func runHealthCheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://localhost:%s/health", port)) // #nosec G704 -- loopback probe, port from our own env
	if err != nil {
		return 1
	}
	defer func() { _ = resp.Body.Close() }()

	// Drain body to allow connection reuse.
	//nolint:errcheck // Best-effort drain; error is irrelevant.
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode == http.StatusOK {
		return 0
	}
	return 1
}
