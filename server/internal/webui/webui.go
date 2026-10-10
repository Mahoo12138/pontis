// Package webui carries the compiled Web app inside the server binary.
//
// The single artifact a self-hoster downloads is one Go executable: `pnpm
// build` at the repository root compiles the Web app, stages its dist into
// this package, and builds the server, so a deployment needs no Node runtime
// and no second static host.
package webui

import (
	"embed"
	"io/fs"
)

// The placeholder in dist is what keeps `go build ./...` working in a checkout
// that has never run a release build; a real build replaces the directory
// contents. The `all:` prefix is what makes go:embed see the dot file.
//
//go:embed all:dist
var dist embed.FS

// distDir is the folder inside the embedded FS that holds the built app.
const distDir = "dist"

// Assets returns the embedded Web dist, rooted at its contents.
func Assets() fs.FS {
	// fs.Sub only fails for an invalid forward path, which "dist" is not.
	sub, err := fs.Sub(dist, distDir)
	if err != nil {
		panic("webui: embedded dist is unreadable: " + err.Error())
	}
	return sub
}
