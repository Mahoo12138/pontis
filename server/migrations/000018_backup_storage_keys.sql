-- 000018_backup_storage_keys: opaque physical name per backup (doc 14 §8).
-- Backups used to be stored under a name built from the space title, so two
-- spaces called "Personal" could overwrite each other's payload. New rows
-- address their file by the backup's own UUID (storage_key); filename stays a
-- display name only.

ALTER TABLE space_backups ADD COLUMN storage_key TEXT NOT NULL DEFAULT '';

-- Legacy rows can be migrated only where the old display name identifies one
-- payload unambiguously. Rows that share a filename keep storage_key='' and
-- are then refused by restore/delete instead of guessing a file owner.
UPDATE space_backups SET storage_key = filename
WHERE storage_key = ''
  AND (SELECT COUNT(*) FROM space_backups AS sibling
       WHERE sibling.filename = space_backups.filename) = 1;

CREATE UNIQUE INDEX idx_space_backups_storage_key
    ON space_backups(storage_key) WHERE storage_key <> '';
