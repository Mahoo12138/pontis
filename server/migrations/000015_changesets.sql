-- 000015_changesets: ChangeSet-level undo and activity history (doc 15).
-- A ChangeSet is one user-facing business operation ("删除了 72 个失效书签")
-- aggregating one or many canonical journal entries (linked via
-- journal.change_set_id). `undo_data` holds the atomic Before Image captured
-- in the same transaction as the canonical mutation; NULL means the
-- ChangeSet is not undoable. Undo never rolls back revisions: it produces
-- new inverse commands recorded as a fresh ChangeSet with `inverse_of`
-- pointing back at the undone one.

CREATE TABLE changesets (
    id                   TEXT PRIMARY KEY,
    space_id             TEXT NOT NULL,
    epoch                INTEGER NOT NULL,
    kind                 TEXT NOT NULL,
    summary              TEXT NOT NULL,
    origin_type          TEXT NOT NULL,
    actor_user_id        TEXT,
    actor_device_id      TEXT,
    first_revision       INTEGER NOT NULL,
    last_revision        INTEGER NOT NULL,
    inverse_of           TEXT,
    undo_data            TEXT,
    undone_by_changeset  TEXT,
    undone_at            TEXT,
    created_at           TEXT NOT NULL
);

CREATE INDEX idx_changesets_space ON changesets (space_id, last_revision DESC);
CREATE INDEX idx_changesets_inverse_of ON changesets (inverse_of);

-- Range lookups of a ChangeSet's journal entries (first/last revision).
CREATE INDEX IF NOT EXISTS idx_journal_changeset
    ON journal (space_id, epoch, change_set_id, revision);
