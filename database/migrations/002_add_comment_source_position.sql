DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM app.co_creation_comments LIMIT 1) THEN
    RAISE EXCEPTION
      'Cannot derive historical comment source positions from PostgreSQL rows; recreate staging and re-import the JSON snapshot.'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

ALTER TABLE app.co_creation_comments
  ADD COLUMN source_position integer NOT NULL,
  ADD CONSTRAINT co_creation_comments_source_position_chk
    CHECK (source_position >= 0),
  ADD CONSTRAINT co_creation_comments_creation_source_position_uq
    UNIQUE (co_creation_id, source_position);

CREATE INDEX co_creation_comments_public_source_order_idx
  ON app.co_creation_comments (co_creation_id, source_position)
  WHERE status = 'kept';
