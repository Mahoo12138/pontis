// Package migrations embeds the forward-only SQLite migration files.
// Files are named NNNNNN_description.sql and applied in lexical order.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
