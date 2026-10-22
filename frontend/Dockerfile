# ===================== Build Stage =====================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies with clean cache.
# --ignore-scripts skips the `sharp` (transitive dep of @capacitor/assets) native
# postinstall, which fails on alpine without build tools. We don't need sharp for
# `vite build` — it's only used to generate Android app icons via `cap assets`.
RUN npm ci --no-audit --no-fund --ignore-scripts && npm cache clean --force

# Copy source code
COPY . .

# Origin of presigned attachment URLs, baked into the Content-Security-Policy
# meta tag by vite.config.ts. Default = production MinIO; docker-compose.yml
# overrides it for the local stack.
ARG VITE_FILES_ORIGIN=https://minio.nothingapp.ru
ENV VITE_FILES_ORIGIN=$VITE_FILES_ORIGIN

# Build the application
RUN npm run build

# ===================== Production Stage =====================
FROM nginx:alpine

# Copy built assets from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# Use wget instead of curl (already in alpine)
# Use 127.0.0.1 instead of localhost to avoid IPv6 resolution issues
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
