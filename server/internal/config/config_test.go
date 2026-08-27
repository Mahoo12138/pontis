package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDefaultsWhenNoFile(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "missing.toml"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Listen != ":8080" {
		t.Errorf("Listen = %q, want :8080", cfg.Listen)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("LogLevel = %q, want info", cfg.LogLevel)
	}
	if cfg.ShutdownTimeout != 10*time.Second {
		t.Errorf("ShutdownTimeout = %v, want 10s", cfg.ShutdownTimeout)
	}
	if want := filepath.Join("data", "pontis.db"); cfg.DatabasePath != want {
		t.Errorf("DatabasePath = %q, want %q", cfg.DatabasePath, want)
	}
}

func TestTomlLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	content := `
listen = "127.0.0.1:9000"
data_dir = "/var/lib/pontis"
public_url = "https://bm.example.com"
log_level = "debug"
trusted_proxies = ["10.0.0.0/8", "172.16.0.0/12"]
shutdown_timeout = "30s"
`
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Listen != "127.0.0.1:9000" {
		t.Errorf("Listen = %q", cfg.Listen)
	}
	if cfg.DataDir != "/var/lib/pontis" {
		t.Errorf("DataDir = %q", cfg.DataDir)
	}
	if cfg.PublicURL != "https://bm.example.com" {
		t.Errorf("PublicURL = %q", cfg.PublicURL)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("LogLevel = %q", cfg.LogLevel)
	}
	if len(cfg.TrustedProxies) != 2 {
		t.Errorf("TrustedProxies = %v", cfg.TrustedProxies)
	}
	if cfg.ShutdownTimeout != 30*time.Second {
		t.Errorf("ShutdownTimeout = %v", cfg.ShutdownTimeout)
	}
}

func TestEnvOverrides(t *testing.T) {
	t.Setenv("PONTIS_LISTEN", ":9999")
	t.Setenv("PONTIS_DATA_DIR", "d2")
	t.Setenv("PONTIS_LOG_LEVEL", "warn")
	t.Setenv("PONTIS_TRUSTED_PROXIES", "1.2.3.4, 5.6.7.8")
	t.Setenv("PONTIS_SHUTDOWN_TIMEOUT", "5s")

	cfg, err := Load(filepath.Join(t.TempDir(), "missing.toml"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Listen != ":9999" {
		t.Errorf("Listen = %q, want :9999", cfg.Listen)
	}
	if cfg.DataDir != "d2" {
		t.Errorf("DataDir = %q", cfg.DataDir)
	}
	if cfg.LogLevel != "warn" {
		t.Errorf("LogLevel = %q", cfg.LogLevel)
	}
	if cfg.ShutdownTimeout != 5*time.Second {
		t.Errorf("ShutdownTimeout = %v", cfg.ShutdownTimeout)
	}
	if len(cfg.TrustedProxies) != 2 || cfg.TrustedProxies[0] != "1.2.3.4" {
		t.Errorf("TrustedProxies = %v", cfg.TrustedProxies)
	}
}

func TestValidateEmptyListen(t *testing.T) {
	t.Setenv("PONTIS_LISTEN", " ")
	_, err := Load("")
	if err == nil {
		t.Fatal("expected error for empty listen")
	}
}
