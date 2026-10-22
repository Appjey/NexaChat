package handlers

import (
	"net/http"
	"testing"

	"go.uber.org/zap"
)

func newOriginTestHandler(origins []string) *webSocketHandler {
	h := &webSocketHandler{logger: zap.NewNop()}
	h.SetAllowedOrigins(origins)
	return h
}

func requestWithOrigin(t *testing.T, origin string) *http.Request {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, "http://backend/ws", http.NoBody)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return req
}

func TestCheckOrigin(t *testing.T) {
	h := newOriginTestHandler([]string{"https://nothingapp.ru", " https://localhost ", ""})

	cases := []struct {
		name   string
		origin string
		want   bool
	}{
		{name: "exact match", origin: "https://nothingapp.ru", want: true},
		{name: "case-insensitive match", origin: "HTTPS://NothingApp.ru", want: true},
		{name: "trimmed entry matches", origin: "https://localhost", want: true},
		{name: "missing origin (non-browser client)", origin: "", want: true},
		{name: "foreign origin", origin: "https://evil.example", want: false},
		{name: "subdomain of allowed host", origin: "https://evil.nothingapp.ru", want: false},
		{name: "allowed host as prefix", origin: "https://nothingapp.ru.evil.example", want: false},
		{name: "scheme downgrade", origin: "http://nothingapp.ru", want: false},
		{name: "extra port", origin: "https://nothingapp.ru:8443", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := h.checkOrigin(requestWithOrigin(t, tc.origin)); got != tc.want {
				t.Fatalf("checkOrigin(%q) = %v, want %v", tc.origin, got, tc.want)
			}
		})
	}
}

func TestCheckOrigin_NoAllowListRejectsBrowsers(t *testing.T) {
	h := &webSocketHandler{logger: zap.NewNop()} // SetAllowedOrigins never called
	if h.checkOrigin(requestWithOrigin(t, "https://nothingapp.ru")) {
		t.Fatal("browser origin must be rejected when no allow-list is configured")
	}
	if !h.checkOrigin(requestWithOrigin(t, "")) {
		t.Fatal("origin-less (non-browser) request must still pass")
	}
}
