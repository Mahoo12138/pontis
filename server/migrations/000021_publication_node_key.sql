-- 000021_publication_node_key: published node ids must not be derived from
-- canonical UUIDs (doc 10 §4/§5). Each publication carries a private key used
-- to derive opaque node ids that stay stable across snapshot updates.
ALTER TABLE publications ADD COLUMN node_key TEXT;

UPDATE publications SET node_key = lower(hex(randomblob(16))) WHERE node_key IS NULL;
