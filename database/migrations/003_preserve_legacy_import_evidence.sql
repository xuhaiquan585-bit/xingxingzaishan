ALTER TABLE app.record_proofs
  ADD COLUMN legacy_hash_snapshot text,
  ADD CONSTRAINT record_proofs_legacy_hash_nonempty_chk
    CHECK (legacy_hash_snapshot IS NULL OR btrim(legacy_hash_snapshot) <> ''),
  ADD CONSTRAINT record_proofs_hash_source_chk
    CHECK (manifest_hash IS NULL OR legacy_hash_snapshot IS NULL);

ALTER TABLE app.co_creation_comments
  ADD COLUMN legacy_duplicate boolean NOT NULL DEFAULT false;

DROP INDEX app.co_creation_comments_effective_account_uq;

CREATE UNIQUE INDEX co_creation_comments_effective_account_uq
  ON app.co_creation_comments (co_creation_id, account_id)
  WHERE status = 'kept' AND legacy_duplicate = false;
