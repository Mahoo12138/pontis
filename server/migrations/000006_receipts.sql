-- 000006_receipts: client operation idempotency receipts.
-- One row per processed client operation. Replays with the same request
-- hash return the stored result; the same op_id with a different payload
-- is a protocol error (OP_ID_REUSED).

CREATE TABLE client_operation_receipts (
    binding_id            TEXT NOT NULL,
    op_id                 TEXT NOT NULL,
    client_seq            INTEGER NOT NULL,
    request_epoch         INTEGER NOT NULL,
    base_revision         INTEGER NOT NULL,
    request_hash          TEXT NOT NULL,
    status                TEXT NOT NULL,
    reason                TEXT NOT NULL DEFAULT '',
    result_revision       INTEGER,
    settle_after_revision INTEGER,
    processed_at_revision INTEGER NOT NULL,
    created_at            TEXT NOT NULL,
    PRIMARY KEY (binding_id, op_id),
    UNIQUE (binding_id, client_seq)
);
