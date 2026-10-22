package handlers

import (
	"context"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

// Close drains all active WebSocket connections and stops the broadcast worker pool.
// Sends a "going away" close frame to every client so they reconnect cleanly on restart.
// Intended to be registered with the graceful-shutdown manager before srv.Shutdown.
func (h *webSocketHandler) Close(ctx context.Context) error {
	h.mu.Lock()
	clients := make([]*wsClient, 0)
	for _, conns := range h.clients {
		clients = append(clients, conns...)
	}
	// Don't wipe the map yet — the read/write loops cleanup themselves and this lets
	// any in-flight broadcast still find its target until conn.Close flushes.
	h.mu.Unlock()

	h.logger.Info("draining WebSocket clients", zap.Int("count", len(clients)))

	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(5 * time.Second)
	}

	closeFrame := websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutting down")
	for _, c := range clients {
		c.writeMu.Lock()
		// Best-effort — the connection is already on its way out, so errors here are expected
		// (peer closed the socket, deadline exceeded). Log at debug so we have a trail without
		// spamming warnings on every shutdown.
		if err := c.conn.WriteControl(websocket.CloseMessage, closeFrame, deadline); err != nil {
			h.logger.Debug("close frame write failed", zap.Error(err), zap.Uint("user_id", c.userID))
		}
		c.writeMu.Unlock()
		if err := c.conn.Close(); err != nil {
			h.logger.Debug("conn close failed", zap.Error(err), zap.Uint("user_id", c.userID))
		}
	}

	// Stop the broadcast pool so worker goroutines exit their range loop.
	h.broadcastPool.Close()

	return nil
}

// workerPool manages a pool of workers to limit concurrent goroutines
type workerPool struct {
	workers  int
	jobQueue chan func()
}

// newWorkerPool creates a new worker pool with the specified number of workers
func newWorkerPool(workers int) *workerPool {
	pool := &workerPool{
		workers:  workers,
		jobQueue: make(chan func(), 1000), // Buffer for 1000 pending jobs
	}

	// Start worker goroutines
	for i := 0; i < workers; i++ {
		go pool.worker()
	}

	return pool
}

// worker processes jobs from the queue
func (p *workerPool) worker() {
	for job := range p.jobQueue {
		job()
	}
}

// Submit adds a job to the worker pool
func (p *workerPool) Submit(job func()) {
	p.jobQueue <- job
}

// Close shuts down the worker pool (optional, for cleanup)
func (p *workerPool) Close() {
	close(p.jobQueue)
}
