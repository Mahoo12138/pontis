-- 000008_space_backups: logical backup catalog (doc 14 §8).
-- The backup payloads live in the data directory; the catalog row is the
-- source of truth for listing, protection and retention.

CREATE TABLE space_backups (
    id             TEXT PRIMARY KEY,
    space_id       TEXT NOT NULL REFERENCES sync_spaces(id),
    kind           TEXT NOT NULL CHECK (kind IN ('manual', 'scheduled', 'safety')),
    filename       TEXT NOT NULL,
    size_bytes     INTEGER NOT NULL,
    node_count     INTEGER NOT NULL,
    bookmark_count INTEGER NOT NULL,
    protected      INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);

CREATE INDEX idx_space_backups_space ON space_backups(space_id, created_at);
