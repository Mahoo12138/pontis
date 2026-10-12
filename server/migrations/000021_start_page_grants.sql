-- 000021_start_page_grants: the start page's read authorization
-- (pontis-start-page-v1 §11.2). One device may read exactly one source folder
-- subtree for its start page.
--
-- A grant is not a sync binding: it creates no subscription, moves no
-- watermark and carries no write authority. It is deliberately not checked
-- out here — folder_id has no foreign key, because a source that stops
-- existing must still resolve to a grant the API can report as unavailable,
-- rather than to a row that vanished with the folder.

CREATE TABLE start_page_grants (
    id          TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL REFERENCES devices(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    space_id    TEXT NOT NULL REFERENCES sync_spaces(id),
    folder_id   TEXT NOT NULL,
    -- Bumped whenever the row is re-pointed at another folder, so a client
    -- can tell a stale cached snapshot from a current one.
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    revoked_at  TEXT
);

-- "This device's source" has to be one folder, not whichever of several rows
-- the query happens to read first.
CREATE UNIQUE INDEX ux_start_page_grants_device
    ON start_page_grants(device_id) WHERE revoked_at IS NULL;

CREATE INDEX idx_start_page_grants_user ON start_page_grants(user_id);
