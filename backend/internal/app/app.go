package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"messenger/internal/config"
	"messenger/internal/handlers"
	"messenger/internal/logger"
	"messenger/internal/models"
	"messenger/internal/shutdown"
	"messenger/internal/storage"

	ratelimit "github.com/JGLTechnologies/gin-rate-limit"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormLogger "gorm.io/gorm/logger"
)

// Infrastructure constants.
const (
	defaultPort          = "8080"
	readHeaderTimeout    = 30 * time.Second
	shutdownTimeout      = 30 * time.Second
	dbMaxIdleConns       = 50
	dbMaxOpenConns       = 200
	dbConnMaxLifetime    = time.Hour
	dbConnMaxIdleTime    = 10 * time.Minute
	dbSlowQueryThreshold = 200 * time.Millisecond
	dbConnectAttempts    = 15 // ~30 s total with dbConnectRetryDelay
	dbConnectRetryDelay  = 2 * time.Second
	rateLimitPerSecond   = 30
)

// Run initializes all dependencies and starts the HTTP server with graceful shutdown.
func Run() error {
	cfg, err := config.LoadConfig()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	// Initialize logger
	log := logger.MustNew(os.Getenv("DEBUG") == "true")
	defer log.Sync()

	// Initialize storage
	fileStorage, err := storage.NewStorage(cfg.Storage, log)
	if err != nil {
		return fmt.Errorf("initialize storage: %w", err)
	}

	// Database connection
	db, err := initDatabase(cfg.DBURL, log)
	if err != nil {
		return fmt.Errorf("initialize database: %w", err)
	}

	// Run migrations
	if err := runMigrations(db, log); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}

	// Initialize Gin router
	router, err := setupRouter(log, cfg)
	if err != nil {
		return fmt.Errorf("setup router: %w", err)
	}

	// Setup routes with dependencies
	wsCleanup, err := handlers.SetupRoutes(router, db, []byte(cfg.JWTSecret), fileStorage, log, cfg)
	if err != nil {
		return fmt.Errorf("setup routes: %w", err)
	}

	// HTTP server
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           router,
		ReadHeaderTimeout: readHeaderTimeout,
	}

	// Graceful shutdown. Drain WebSocket clients first (send CloseGoingAway so the
	// frontend reconnect loop doesn't flap), then stop the HTTP server, then close DB.
	shutdownMgr := shutdown.New(log, shutdownTimeout)
	shutdownMgr.Register(func(ctx context.Context) error {
		log.Info("draining WebSocket connections...")
		return wsCleanup(ctx)
	})
	shutdownMgr.Register(func(ctx context.Context) error {
		log.Info("stopping HTTP server...")
		return srv.Shutdown(ctx)
	})
	shutdownMgr.Register(func(ctx context.Context) error {
		log.Info("closing database...")
		sqlDB, err := db.DB()
		if err != nil {
			return fmt.Errorf("get database instance: %w", err)
		}
		return sqlDB.Close()
	})

	// Start server in goroutine
	go func() {
		log.Info("starting server", zap.String("port", port))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal("server error", zap.Error(err))
		}
	}()

	// Wait for shutdown signal
	shutdownMgr.Wait()
	log.Info("server stopped")
	return nil
}

func initDatabase(dbURL string, log *zap.Logger) (*gorm.DB, error) {
	gormConfig := &gorm.Config{
		Logger: gormLogger.New(
			&zapGormLogger{log: log},
			gormLogger.Config{
				SlowThreshold:             dbSlowQueryThreshold,
				LogLevel:                  gormLogger.Warn,
				IgnoreRecordNotFoundError: true,
				Colorful:                  false,
			},
		),
		PrepareStmt:                              true,
		QueryFields:                              true,
		DisableForeignKeyConstraintWhenMigrating: true,
	}

	// Retry the initial connection: under docker compose `depends_on:
	// service_healthy` already serializes startup, but when the backend runs
	// outside Docker (go run, IDE run configuration) it is routinely started a
	// few seconds before Postgres finishes booting.
	log.Info("connecting to database...")
	var db *gorm.DB
	for attempt := 1; ; attempt++ {
		var err error
		db, err = gorm.Open(postgres.Open(dbURL), gormConfig)
		if err == nil {
			break
		}
		if attempt >= dbConnectAttempts {
			return nil, fmt.Errorf("connect to database after %d attempts: %w", attempt, err)
		}
		log.Warn("database not ready, retrying",
			zap.Int("attempt", attempt),
			zap.Duration("retry_in", dbConnectRetryDelay),
			zap.Error(err),
		)
		time.Sleep(dbConnectRetryDelay)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("get database instance: %w", err)
	}

	sqlDB.SetMaxIdleConns(dbMaxIdleConns)
	sqlDB.SetMaxOpenConns(dbMaxOpenConns)
	sqlDB.SetConnMaxLifetime(dbConnMaxLifetime)
	sqlDB.SetConnMaxIdleTime(dbConnMaxIdleTime)

	log.Info("database connection pool configured")
	return db, nil
}

type zapGormLogger struct {
	log *zap.Logger
}

func (l *zapGormLogger) Printf(format string, args ...interface{}) {
	l.log.Sugar().Infof(format, args...)
}

func runMigrations(db *gorm.DB, log *zap.Logger) error {
	log.Info("running database migrations...")

	// Drop legacy FK constraints on chats.user1_id/user2_id BEFORE AutoMigrate.
	// Group chats use chat_participants and leave these fields as NULL, which breaks
	// FK constraints. Must drop first so AutoMigrate doesn't fail trying to re-add them.
	if err := db.Exec("ALTER TABLE chats DROP CONSTRAINT IF EXISTS fk_chats_user1").Error; err != nil {
		log.Warn("failed to drop fk_chats_user1 constraint", zap.Error(err))
	}
	if err := db.Exec("ALTER TABLE chats DROP CONSTRAINT IF EXISTS fk_chats_user2").Error; err != nil {
		log.Warn("failed to drop fk_chats_user2 constraint", zap.Error(err))
	}

	// Migrate group chats: set user1_id/user2_id from 0 to NULL.
	// With *uint fields, NULL values don't violate the idx_chat_users unique index,
	// allowing multiple group chats to coexist.
	if err := db.Exec("UPDATE chats SET user1_id = NULL, user2_id = NULL WHERE is_group = true AND (user1_id = 0 OR user2_id = 0)").Error; err != nil {
		log.Warn("failed to nullify group chat user IDs", zap.Error(err))
	}

	// Composite index for the most common message query pattern:
	//   WHERE chat_id = ? AND is_deleted = false ORDER BY created_at DESC LIMIT N
	// gorm.Model's CreatedAt is embedded so we can't retag it; create the index via SQL.
	if err := db.Exec("CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages (chat_id, created_at DESC)").Error; err != nil {
		log.Warn("failed to create idx_messages_chat_created", zap.Error(err))
	}

	if err := db.AutoMigrate(
		&models.User{},
		&models.Chat{},
		&models.Message{},
		&models.MessageEnvelope{},
		&models.Contact{},
		&models.Attachment{},
		&models.AttachmentEnvelope{},
		&models.UnreadMessage{},
		&models.MessageReceipt{},
		&models.PushSubscription{},
		&models.ChatParticipant{},
		&models.PinnedMessage{},
		&models.FCMToken{},
		&models.AppRelease{},
		&models.Session{},
	); err != nil {
		return err
	}

	// Drop legacy plaintext metadata columns on `attachments`. The render-bucket,
	// filename and claimed mime are now AES-GCM-wrapped under file_key in
	// encrypted_metadata/metadata_iv; keeping these columns around would leave
	// the operator with a `pg_dump`-visible window into "tax_returns_2026.pdf"
	// from old rows and silently let new uploads ride the legacy path. Idempotent:
	// HasColumn → false on subsequent runs.
	migrator := db.Migrator()
	for _, col := range []string{"file_type", "file_name", "mime_type"} {
		if !migrator.HasColumn(&models.Attachment{}, col) {
			continue
		}
		if err := migrator.DropColumn(&models.Attachment{}, col); err != nil {
			log.Warn("failed to drop legacy attachment column", zap.String("column", col), zap.Error(err))
		} else {
			log.Info("dropped legacy attachment column", zap.String("column", col))
		}
	}

	return nil
}

func setupRouter(log *zap.Logger, cfg *config.Config) (*gin.Engine, error) {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()

	// gin.New() trusts every proxy by default, which makes c.ClientIP() return
	// whatever the client put in X-Forwarded-For — and that IP keys the rate
	// limiter below. Restrict trust to the reverse proxies actually in front
	// of us (nginx containers on the Docker bridge network, or localhost in dev).
	if err := router.SetTrustedProxies(cfg.TrustedProxies); err != nil {
		return nil, fmt.Errorf("set trusted proxies: %w", err)
	}
	log.Info("trusted proxies", zap.Strings("cidrs", cfg.TrustedProxies))

	// Custom logger middleware using zap
	router.Use(ginZapLogger(log))
	router.Use(gin.Recovery())

	// CORS — Capacitor Android WebView with androidScheme=https reports origin https://localhost.
	// gin-contrib/cors rejects custom schemes (capacitor://), so we only need https://localhost.
	// The same list gates the WebSocket upgrade (see webSocketHandler.checkOrigin).
	log.Info("CORS allowed origins", zap.Strings("origins", cfg.AllowedOrigins))

	router.Use(cors.New(cors.Config{
		AllowOrigins: cfg.AllowedOrigins,
		AllowMethods: []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"Origin", "Content-Type", "Authorization"},
		// Exposed so the frontend can read the rotated JWT minted by the auth middleware's
		// sliding-window refresh. Without ExposeHeaders, fetch() in the browser hides
		// every response header except a CORS-safelisted shortlist.
		ExposeHeaders:    []string{"X-Refresh-Token"},
		AllowCredentials: true,
	}))

	// Rate limiting
	store := ratelimit.InMemoryStore(&ratelimit.InMemoryOptions{
		Rate:  time.Second,
		Limit: rateLimitPerSecond,
	})
	rateLimiterMiddleware := ratelimit.RateLimiter(store, &ratelimit.Options{
		ErrorHandler: func(c *gin.Context, info ratelimit.Info) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many requests"})
		},
		KeyFunc: func(c *gin.Context) string {
			return c.ClientIP()
		},
	})

	router.Use(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/ws") {
			c.Next()
			return
		}
		rateLimiterMiddleware(c)
	})

	// Cap JSON/form-urlencoded request bodies at 1 MB to keep attackers from streaming
	// gigabyte payloads into ShouldBindJSON and blowing memory. Multipart uploads are
	// exempt — they have their own size ceilings (see handlers/constants.go and the
	// per-type limits applied inside attachment handlers).
	const maxJSONBodyBytes = 1 << 20 // 1 MiB
	router.Use(func(c *gin.Context) {
		ct := c.GetHeader("Content-Type")
		if strings.HasPrefix(ct, "multipart/") {
			c.Next()
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxJSONBodyBytes)
		c.Next()
	})

	return router, nil
}

func ginZapLogger(log *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		// The WebSocket handshake carries the JWT as ?token=... (browsers can't
		// set Authorization on a WebSocket). Never let that query string reach
		// the logs — a log reader would otherwise hold a valid session token.
		query := c.Request.URL.RawQuery
		if strings.HasPrefix(path, "/ws") {
			query = "[redacted]"
		}

		c.Next()

		latency := time.Since(start)

		if len(c.Errors) > 0 {
			log.Error("request error",
				zap.String("path", path),
				zap.String("query", query),
				zap.Int("status", c.Writer.Status()),
				zap.Duration("latency", latency),
				zap.Strings("errors", c.Errors.Errors()),
			)
		} else {
			log.Info("request",
				zap.String("path", path),
				zap.Int("status", c.Writer.Status()),
				zap.Duration("latency", latency),
			)
		}
	}
}
