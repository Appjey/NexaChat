# syntax=docker/dockerfile:1.4

# ===================== Build Stage =====================
FROM golang:1.26-alpine AS builder

# Install build dependencies in single layer
RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /app

# Copy go mod files first for better layer caching
COPY go.mod go.sum ./

# Download dependencies with BuildKit cache
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download && go mod verify

# Copy source code
COPY cmd/ ./cmd/
COPY internal/ ./internal/

# Build with BuildKit cache for faster rebuilds (up to 20x speedup)
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags='-w -s -buildid=' \
    -trimpath \
    -o messenger ./cmd/server

# ===================== Final Stage =====================
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app

# Copy timezone data from builder
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo

# Copy CA certificates
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Copy binary from builder
COPY --from=builder /app/messenger .

# Distroless nonroot image already runs as non-root user (uid 65532)

EXPOSE 8080

CMD ["./messenger"]
