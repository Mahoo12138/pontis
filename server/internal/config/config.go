// Package config loads server deployment configuration from a TOML file
// with environment variable overrides (prefix PONTIS_).
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config holds deployment settings. Product settings editable from the Web UI
// live in SQLite (system_settings), not here.
type Config struct {
	Listen          string        `toml:"listen"`
	DataDir         string        `toml:"data_dir"`
	PublicURL       string        `toml:"public_url"`
	LogLevel        string        `toml:"log_level"`
	TrustedProxies  []string      `toml:"trusted_proxies"`
	ShutdownTimeout time.Duration `toml:"shutdown_timeout"`

	// LinkCheckAllow lists CIDR ranges the server may reach when checking a
	// user's link. Empty means only publicly routable addresses, which is
	// the safe default: a link check runs with the server's own network
	// identity.
	LinkCheckAllow []string `toml:"link_check_allow_cidrs"`

	// DatabasePath is derived from DataDir and not configurable via TOML.
	DatabasePath string `toml:"-"`
}

// Default returns the built-in defaults.
func Default() Config {
	return Config{
		Listen:          ":8080",
		DataDir:         "data",
		LogLevel:        "info",
		ShutdownTimeout: 10 * time.Second,
	}
}

// Load reads the TOML file at path (skipped if it does not exist), applies
// environment overrides, then validates the result.
func Load(path string) (Config, error) {
	cfg := Default()

	if path != "" {
		if _, err := os.Stat(path); err == nil {
			if _, err := toml.DecodeFile(path, &cfg); err != nil {
				return Config{}, fmt.Errorf("decode %s: %w", path, err)
			}
		} else if !os.IsNotExist(err) {
			return Config{}, fmt.Errorf("stat %s: %w", path, err)
		}
	}

	applyEnv(&cfg)

	cfg.DatabasePath = filepath.Join(cfg.DataDir, "pontis.db")

	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func applyEnv(cfg *Config) {
	if v, ok := os.LookupEnv("PONTIS_LISTEN"); ok {
		cfg.Listen = v
	}
	if v, ok := os.LookupEnv("PONTIS_DATA_DIR"); ok {
		cfg.DataDir = v
	}
	if v, ok := os.LookupEnv("PONTIS_PUBLIC_URL"); ok {
		cfg.PublicURL = v
	}
	if v, ok := os.LookupEnv("PONTIS_LOG_LEVEL"); ok {
		cfg.LogLevel = v
	}
	if v, ok := os.LookupEnv("PONTIS_TRUSTED_PROXIES"); ok {
		cfg.TrustedProxies = splitList(v)
	}
	if v, ok := os.LookupEnv("PONTIS_LINK_CHECK_ALLOW_CIDRS"); ok {
		cfg.LinkCheckAllow = splitList(v)
	}
	if v, ok := os.LookupEnv("PONTIS_SHUTDOWN_TIMEOUT"); ok {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.ShutdownTimeout = d
		}
	}
}

func splitList(v string) []string {
	if strings.TrimSpace(v) == "" {
		return nil
	}
	parts := strings.Split(v, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func (c Config) validate() error {
	if strings.TrimSpace(c.Listen) == "" {
		return fmt.Errorf("config: listen must not be empty")
	}
	if strings.TrimSpace(c.DataDir) == "" {
		return fmt.Errorf("config: data_dir must not be empty")
	}
	if c.ShutdownTimeout <= 0 {
		return fmt.Errorf("config: shutdown_timeout must be positive")
	}
	return nil
}
