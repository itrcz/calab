// Command server runs the Calaba API (and, in the next stage, the realtime gateway).
//
//	server [serve]          run the HTTP server (migrates first unless MIGRATE_ON_START=false)
//	server migrate [status] apply pending migrations (or print their status) and exit
//	server healthcheck      GET /readyz on HTTP_ADDR, exit 0 if ready (container healthcheck)
//	server tochka …         Tochka webhook registration and key check (ADR-0083; TOCHKA_* env only)
//	server tochkapay …      Pay Gateway public key and test-site smoke (ADR-0083 phase 3; TOCHKA_* env only)
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/calaba/calaba/server/internal/app"
	"github.com/calaba/calaba/server/internal/blob"
	"github.com/calaba/calaba/server/internal/buildinfo"
	"github.com/calaba/calaba/server/internal/config"
	"github.com/calaba/calaba/server/internal/db"
	"github.com/calaba/calaba/server/internal/plans"
	"github.com/calaba/calaba/server/internal/push"
	"github.com/calaba/calaba/server/internal/redisx"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func setupLogger(level string) {
	var l slog.Level
	if err := l.UnmarshalText([]byte(strings.ToUpper(level))); err != nil {
		l = slog.LevelInfo
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: l})))
}

func run(args []string) error {
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
	}
	if cmd == "healthcheck" { // needs only HTTP_ADDR, not the full config
		return healthcheck(os.Getenv("HTTP_ADDR"))
	}
	if cmd == "tochka" { // needs only TOCHKA_*, not the full config
		return tochkaCmd(context.Background(), args[1:], os.Stdout)
	}
	if cmd == "tochkapay" { // needs only TOCHKA_*, not the full config
		return tochkapayCmd(context.Background(), args[1:], os.Stdout)
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	setupLogger(cfg.LogLevel)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch cmd {
	case "serve":
		return serve(ctx, cfg)
	case "migrate":
		return migrate(ctx, cfg, args[1:])
	default:
		return fmt.Errorf("unknown command %q (want serve | migrate [status] | healthcheck)", cmd)
	}
}

func migrate(ctx context.Context, cfg *config.Config, args []string) error {
	d, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer d.Close()
	if len(args) > 0 && args[0] == "status" {
		lines, err := d.MigrationStatus(ctx)
		if err != nil {
			return err
		}
		for _, l := range lines {
			fmt.Println(l)
		}
		return nil
	}
	return d.Migrate(ctx)
}

func serve(ctx context.Context, cfg *config.Config) error {
	if _, _, _, err := plans.Defaults(cfg.PlanFreeLimits, cfg.PlanTeamLimits, cfg.PlanBusinessLimits); err != nil {
		return fmt.Errorf("config: PLAN_FREE_LIMITS / PLAN_TEAM_LIMITS / PLAN_BUSINESS_LIMITS: %w", err)
	}
	d, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer d.Close()
	if cfg.MigrateOnStart {
		if err := d.Migrate(ctx); err != nil {
			return err
		}
	}
	rc, err := redisx.Connect(ctx, cfg.RedisURL)
	if err != nil {
		return err
	}
	defer rc.Close()

	store, err := blob.Open(ctx, app.BlobConfig(cfg))
	if err != nil {
		return err
	}
	providers, err := push.NewProviders(cfg)
	if err != nil {
		return err
	}
	a := app.New(app.Deps{Config: cfg, DB: d, Redis: rc, Blob: store, Push: providers})
	bg, stopBG := context.WithCancel(context.WithoutCancel(ctx))
	defer stopBG()
	a.Run(bg)
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           a.Handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second, // file uploads will extend this per request
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
		// No WriteTimeout: gateway sockets and file downloads are long-lived; handlers set
		// their own deadlines via http.ResponseController.
	}
	errc := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", cfg.HTTPAddr, "version", buildinfo.Version, "commit", buildinfo.Info().GetCommit(),
			"registration", cfg.RegistrationMode,
			"storage", cfg.StorageDriver, "livekit", cfg.LiveKitEnabled(), "mail", cfg.MailEnabled())
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		slog.Info("shutting down")
		shCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
		defer cancel()
		// Gateway sockets are hijacked connections that http.Server.Shutdown does not wait
		// for: ask clients to reconnect (spread over a few seconds) and hand sessions off.
		a.Gateway.Shutdown(shCtx)
		if err := srv.Shutdown(shCtx); err != nil {
			return err
		}
		stopBG()
	}
	return nil
}

// healthcheck probes the local server's readiness (postgres + redis) for container
// healthchecks in images without curl.
func healthcheck(addr string) error {
	if addr == "" {
		addr = "127.0.0.1:3000"
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// Target = our own HTTP_ADDR (operator config), probed on loopback.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(host, port)+"/readyz", nil) //nolint:gosec // G704, see above
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req) //nolint:gosec // G704: own address
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("not ready: %d %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}
