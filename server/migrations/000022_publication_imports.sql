-- 000022_publication_imports: consumer side of a publication (doc 10 §9).
-- One row per (user, publication, target space, target parent) records the
-- version that was applied; the mapping table binds published node ids to the
-- canonical nodes they became, so a later update touches those nodes instead
-- of guessing identity from title and URL again.
--
-- target_space_id carries no foreign key on purpose: deleting a space already
-- refuses while a publication refers to it, and an import whose space is gone
-- is inert history rather than a second deletion blocker.

CREATE TABLE publication_imports (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
    last_version   INTEGER NOT NULL,
    target_space_id TEXT NOT NULL,
    target_parent  TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE (user_id, publication_id, target_space_id, target_parent)
);

CREATE INDEX idx_publication_imports_owner
    ON publication_imports(user_id, publication_id);

CREATE TABLE publication_import_mappings (
    import_id           TEXT NOT NULL REFERENCES publication_imports(id) ON DELETE CASCADE,
    publication_node_id TEXT NOT NULL,
    canonical_node_id   TEXT NOT NULL,
    PRIMARY KEY (import_id, publication_node_id)
);
