package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		client := &http.Client{Timeout: 2 * time.Second}
		resp, err := client.Get("http://127.0.0.1:8765/healthz")
		if err != nil || resp.StatusCode != 200 {
			os.Exit(1)
		}
		resp.Body.Close()
		return
	}
	if len(os.Args) != 2 || (os.Args[1] != "serve" && os.Args[1] != "authorize") {
		fmt.Fprintln(os.Stderr, "usage: sumorp {authorize|serve|healthcheck}")
		os.Exit(2)
	}
	configPath := os.Getenv("SUMORP_CONFIG")
	if configPath == "" {
		configPath = "config.yaml"
	}
	c, err := loadConfig(configPath)
	if err != nil {
		slog.Error("configuration", "error", err)
		os.Exit(1)
	}
	m, err := newTokenManager(c, nil)
	if err != nil {
		slog.Error("credentials", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if os.Args[1] == "authorize" {
		if err := m.authorize(ctx, os.Stdout); err != nil {
			slog.Error("authorize", "error", err)
			os.Exit(1)
		}
		return
	}
	srv := &http.Server{Addr: c.Listen, Handler: newProxy(c, m), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("serve", "error", err)
		os.Exit(1)
	}
}
