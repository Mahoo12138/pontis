-- 000023_publication_versions: the snapshots a publication has carried
-- (doc 10 §4, doc 18 §9). publications.tree stays the current one so every
-- read path keeps working unchanged; a version row is appended whenever the
-- publisher re-captures, which is what lets a consumer see what moved and
-- what an import is being updated from.

CREATE TABLE publication_versions (
    id             TEXT PRIMARY KEY,
    publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
    version        INTEGER NOT NULL,
    bookmark_count INTEGER NOT NULL,
    folder_count   INTEGER NOT NULL,
    note           TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    UNIQUE (publication_id, version)
);

CREATE INDEX idx_publication_versions_list
    ON publication_versions(publication_id, version DESC);

-- Every publication already had at least the version it is on now. Older
-- re-captures are not recoverable, so the row says what it actually knows.
INSERT INTO publication_versions
    (id, publication_id, version, bookmark_count, folder_count, note, created_at)
SELECT lower(hex(randomblob(16))), id, version, bookmark_count, folder_count,
       '已发布的快照', updated_at
FROM publications;
