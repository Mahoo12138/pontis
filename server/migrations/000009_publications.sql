-- 000009_publications: versioned share trees (doc 10).
-- The tree snapshot JSON uses publication-local node ids, deliberately
-- unrelated to any canonical UUID; metadata only, no private revisions.

CREATE TABLE publications (
    id            TEXT PRIMARY KEY,
    slug          TEXT NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    space_id      TEXT NOT NULL REFERENCES sync_spaces(id),
    root_node_id  TEXT,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    tags          TEXT NOT NULL DEFAULT '[]',
    version       INTEGER NOT NULL DEFAULT 1,
    visibility    TEXT NOT NULL CHECK (visibility IN ('private', 'plaza')),
    tree          TEXT NOT NULL,
    bookmark_count INTEGER NOT NULL,
    folder_count  INTEGER NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE INDEX idx_publications_owner ON publications(owner_user_id);
CREATE INDEX idx_publications_visibility ON publications(visibility, updated_at);
