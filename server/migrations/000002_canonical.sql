-- 000002_canonical: canonical tree tables (SyncSpace / RootSlot / Node).
-- Revision/journal/tombstone bookkeeping lands with the sync engine module;
-- the revision columns are part of the node contract from day one.

CREATE TABLE sync_spaces (
    id                     TEXT PRIMARY KEY,
    owner_user_id          TEXT NOT NULL,
    name                   TEXT NOT NULL,
    epoch                  INTEGER NOT NULL DEFAULT 1 CHECK (epoch >= 1),
    current_revision       INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
    journal_floor_revision INTEGER NOT NULL DEFAULT 0,
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    CHECK (journal_floor_revision >= 0 AND journal_floor_revision <= current_revision)
);

CREATE TABLE root_slots (
    space_id     TEXT NOT NULL REFERENCES sync_spaces(id),
    key          TEXT NOT NULL,
    display_name TEXT NOT NULL,
    position     INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (space_id, key)
);

CREATE TABLE nodes (
    space_id           TEXT NOT NULL,
    id                 TEXT NOT NULL,
    type               TEXT NOT NULL CHECK (type IN ('folder', 'bookmark')),
    title              TEXT NOT NULL,
    url                TEXT,
    parent_id          TEXT,
    root_key           TEXT,
    position           INTEGER NOT NULL,
    created_revision   INTEGER NOT NULL,
    title_revision     INTEGER NOT NULL,
    url_revision       INTEGER NOT NULL,
    structure_revision INTEGER NOT NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (space_id, id),
    -- exactly one of parent_id / root_key
    CHECK ((parent_id IS NULL) <> (root_key IS NULL)),
    -- folder: url NULL; bookmark: url NOT NULL
    CHECK (type = 'folder' OR url IS NOT NULL),
    CHECK (type = 'bookmark' OR url IS NULL),
    FOREIGN KEY (space_id, parent_id) REFERENCES nodes(space_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (space_id, root_key) REFERENCES root_slots(space_id, key)
);

CREATE INDEX idx_nodes_parent_pos ON nodes(space_id, parent_id, position);
CREATE INDEX idx_nodes_root_pos ON nodes(space_id, root_key, position);
CREATE INDEX idx_nodes_type ON nodes(space_id, type);
CREATE INDEX idx_nodes_url ON nodes(space_id, url);
