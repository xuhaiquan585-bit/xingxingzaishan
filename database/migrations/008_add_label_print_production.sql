CREATE TABLE app.label_templates (
  id uuid PRIMARY KEY,
  name varchar(160) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft',
  current_published_version_id uuid,
  created_by_operator_id bigint,
  created_by_snapshot varchar(120) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz,
  CONSTRAINT label_templates_name_nonempty_chk CHECK (btrim(name) <> ''),
  CONSTRAINT label_templates_status_chk
    CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT label_templates_creator_fk
    FOREIGN KEY (created_by_operator_id) REFERENCES app.operators (id) ON DELETE RESTRICT,
  CONSTRAINT label_templates_updated_at_chk CHECK (updated_at >= created_at),
  CONSTRAINT label_templates_archived_at_chk
    CHECK (
      (status <> 'archived' AND archived_at IS NULL)
      OR (status = 'archived' AND archived_at IS NOT NULL AND archived_at >= created_at)
    )
);

CREATE UNIQUE INDEX label_templates_name_uq
  ON app.label_templates (lower(name));
CREATE INDEX label_templates_status_updated_idx
  ON app.label_templates (status, updated_at DESC);

CREATE TABLE app.label_template_versions (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL,
  version_number integer NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'draft',
  width_mm numeric(8, 3) NOT NULL,
  height_mm numeric(8, 3) NOT NULL,
  dpi integer NOT NULL DEFAULT 600,
  schema_version integer NOT NULL DEFAULT 1,
  template_schema jsonb NOT NULL,
  created_by_operator_id bigint,
  created_by_snapshot varchar(120) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  published_by_operator_id bigint,
  published_by_snapshot varchar(120) NOT NULL DEFAULT '',
  published_at timestamptz,
  CONSTRAINT label_template_versions_template_version_uq
    UNIQUE (template_id, version_number),
  CONSTRAINT label_template_versions_template_fk
    FOREIGN KEY (template_id) REFERENCES app.label_templates (id) ON DELETE RESTRICT,
  CONSTRAINT label_template_versions_creator_fk
    FOREIGN KEY (created_by_operator_id) REFERENCES app.operators (id) ON DELETE RESTRICT,
  CONSTRAINT label_template_versions_publisher_fk
    FOREIGN KEY (published_by_operator_id) REFERENCES app.operators (id) ON DELETE RESTRICT,
  CONSTRAINT label_template_versions_number_chk CHECK (version_number > 0),
  CONSTRAINT label_template_versions_status_chk
    CHECK (status IN ('draft', 'published')),
  CONSTRAINT label_template_versions_width_chk CHECK (width_mm >= 10 AND width_mm <= 300),
  CONSTRAINT label_template_versions_height_chk CHECK (height_mm >= 10 AND height_mm <= 600),
  CONSTRAINT label_template_versions_dpi_chk CHECK (dpi = 600),
  CONSTRAINT label_template_versions_schema_version_chk CHECK (schema_version = 1),
  CONSTRAINT label_template_versions_schema_object_chk
    CHECK (jsonb_typeof(template_schema) = 'object'),
  CONSTRAINT label_template_versions_updated_at_chk CHECK (updated_at >= created_at),
  CONSTRAINT label_template_versions_published_at_chk
    CHECK (
      (status = 'draft' AND published_at IS NULL)
      OR (status = 'published' AND published_at IS NOT NULL AND published_at >= created_at)
    )
);

CREATE UNIQUE INDEX label_template_versions_one_draft_uq
  ON app.label_template_versions (template_id) WHERE status = 'draft';
CREATE INDEX label_template_versions_template_status_idx
  ON app.label_template_versions (template_id, status, version_number DESC);

ALTER TABLE app.label_templates
  ADD CONSTRAINT label_templates_current_published_version_fk
  FOREIGN KEY (current_published_version_id)
  REFERENCES app.label_template_versions (id)
  ON DELETE RESTRICT;

CREATE TABLE app.label_template_assets (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL,
  asset_type varchar(24) NOT NULL,
  object_key text NOT NULL,
  mime_type varchar(80) NOT NULL,
  pixel_width integer NOT NULL,
  pixel_height integer NOT NULL,
  size_bytes bigint NOT NULL,
  created_by_operator_id bigint,
  created_by_snapshot varchar(120) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  CONSTRAINT label_template_assets_template_fk
    FOREIGN KEY (template_id) REFERENCES app.label_templates (id) ON DELETE RESTRICT,
  CONSTRAINT label_template_assets_creator_fk
    FOREIGN KEY (created_by_operator_id) REFERENCES app.operators (id) ON DELETE RESTRICT,
  CONSTRAINT label_template_assets_type_chk CHECK (asset_type IN ('logo', 'background')),
  CONSTRAINT label_template_assets_object_key_nonempty_chk CHECK (btrim(object_key) <> ''),
  CONSTRAINT label_template_assets_mime_type_chk CHECK (mime_type IN ('image/png', 'image/jpeg')),
  CONSTRAINT label_template_assets_dimensions_chk
    CHECK (pixel_width > 0 AND pixel_height > 0),
  CONSTRAINT label_template_assets_size_chk CHECK (size_bytes > 0),
  CONSTRAINT label_template_assets_template_object_key_uq UNIQUE (template_id, object_key)
);

CREATE INDEX label_template_assets_template_created_idx
  ON app.label_template_assets (template_id, created_at DESC);

CREATE TABLE app.print_batches (
  id text PRIMARY KEY,
  name varchar(160) NOT NULL,
  template_version_id uuid NOT NULL,
  status varchar(32) NOT NULL,
  qr_count integer NOT NULL,
  vendor_name varchar(160) NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  idempotency_key uuid NOT NULL,
  artifact_object_key text,
  artifact_sha256 char(64),
  artifact_size_bytes bigint,
  generation_attempt_count integer NOT NULL DEFAULT 0,
  generation_error_code varchar(120) NOT NULL DEFAULT '',
  generated_at timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  first_downloaded_at timestamptz,
  last_downloaded_at timestamptz,
  last_downloaded_by_snapshot varchar(120) NOT NULL DEFAULT '',
  printing_started_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  voided_at timestamptz,
  void_reason text NOT NULL DEFAULT '',
  created_by_operator_id bigint,
  created_by_snapshot varchar(120) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT print_batches_id_nonempty_chk CHECK (btrim(id) <> ''),
  CONSTRAINT print_batches_name_nonempty_chk CHECK (btrim(name) <> ''),
  CONSTRAINT print_batches_template_version_fk
    FOREIGN KEY (template_version_id) REFERENCES app.label_template_versions (id) ON DELETE RESTRICT,
  CONSTRAINT print_batches_creator_fk
    FOREIGN KEY (created_by_operator_id) REFERENCES app.operators (id) ON DELETE RESTRICT,
  CONSTRAINT print_batches_status_chk
    CHECK (status IN (
      'reserved', 'generating', 'generation_failed', 'artifact_ready',
      'printing', 'completed', 'canceled', 'voided'
    )),
  CONSTRAINT print_batches_qr_count_chk CHECK (qr_count BETWEEN 1 AND 500),
  CONSTRAINT print_batches_generation_attempt_count_chk CHECK (generation_attempt_count >= 0),
  CONSTRAINT print_batches_download_count_chk CHECK (download_count >= 0),
  CONSTRAINT print_batches_artifact_sha256_format_chk
    CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT print_batches_artifact_size_chk
    CHECK (artifact_size_bytes IS NULL OR artifact_size_bytes > 0),
  CONSTRAINT print_batches_artifact_contract_chk
    CHECK (
      (
        status IN ('artifact_ready', 'printing', 'completed', 'voided')
        AND artifact_object_key IS NOT NULL
        AND artifact_sha256 IS NOT NULL
        AND artifact_size_bytes IS NOT NULL
        AND generated_at IS NOT NULL
      )
      OR
      (
        status IN ('reserved', 'generating', 'generation_failed', 'canceled')
        AND artifact_object_key IS NULL
        AND artifact_sha256 IS NULL
        AND artifact_size_bytes IS NULL
        AND generated_at IS NULL
      )
    ),
  CONSTRAINT print_batches_download_times_chk
    CHECK (
      (download_count = 0 AND first_downloaded_at IS NULL AND last_downloaded_at IS NULL)
      OR
      (download_count > 0 AND first_downloaded_at IS NOT NULL
        AND last_downloaded_at IS NOT NULL
        AND last_downloaded_at >= first_downloaded_at)
    ),
  CONSTRAINT print_batches_terminal_times_chk
    CHECK (
      (status = 'canceled') = (canceled_at IS NOT NULL)
      AND (status = 'voided') = (voided_at IS NOT NULL)
      AND (status = 'completed') = (completed_at IS NOT NULL)
    ),
  CONSTRAINT print_batches_printing_started_at_chk
    CHECK (printing_started_at IS NULL OR printing_started_at >= created_at),
  CONSTRAINT print_batches_updated_at_chk CHECK (updated_at >= created_at),
  CONSTRAINT print_batches_void_reason_chk
    CHECK ((status = 'voided' AND btrim(void_reason) <> '') OR (status <> 'voided')),
  CONSTRAINT print_batches_idempotency_key_uq UNIQUE (idempotency_key),
  CONSTRAINT print_batches_artifact_object_key_uq UNIQUE (artifact_object_key)
);

CREATE INDEX print_batches_status_updated_idx
  ON app.print_batches (status, updated_at DESC);
CREATE INDEX print_batches_template_created_idx
  ON app.print_batches (template_version_id, created_at DESC);

ALTER TABLE app.qr_codes
  ADD COLUMN print_status varchar(32),
  ADD COLUMN print_status_updated_at timestamptz,
  ADD COLUMN print_void_reason text NOT NULL DEFAULT '';

UPDATE app.qr_codes
SET print_status = 'legacy_unclassified',
    print_status_updated_at = CURRENT_TIMESTAMP;

ALTER TABLE app.qr_codes
  ALTER COLUMN print_status SET DEFAULT 'available',
  ALTER COLUMN print_status SET NOT NULL,
  ALTER COLUMN print_status_updated_at SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN print_status_updated_at SET NOT NULL;

ALTER TABLE app.qr_codes
  ADD CONSTRAINT qr_codes_print_status_chk
  CHECK (print_status IN (
    'legacy_unclassified', 'available', 'reserved',
    'artifact_generated', 'printed', 'voided'
  )),
  ADD CONSTRAINT qr_codes_print_status_relation_chk
  CHECK (
    (print_status IN ('legacy_unclassified', 'available') AND print_batch_id IS NULL)
    OR (print_status IN ('reserved', 'artifact_generated', 'printed') AND print_batch_id IS NOT NULL)
    OR print_status = 'voided'
  ) NOT VALID,
  ADD CONSTRAINT qr_codes_print_void_reason_chk
  CHECK (
    (print_status = 'voided' AND btrim(print_void_reason) <> '')
    OR (print_status <> 'voided' AND print_void_reason = '')
  ),
  ADD CONSTRAINT qr_codes_print_batch_fk
  FOREIGN KEY (print_batch_id) REFERENCES app.print_batches (id) ON DELETE RESTRICT NOT VALID;

CREATE INDEX qr_codes_print_status_idx
  ON app.qr_codes (print_status, print_status_updated_at DESC);
CREATE INDEX qr_codes_print_batch_status_idx
  ON app.qr_codes (print_batch_id, print_status) WHERE print_batch_id IS NOT NULL;

CREATE FUNCTION app.prevent_published_template_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Published label template versions are immutable.',
      CONSTRAINT = 'label_template_versions_published_immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER label_template_versions_prevent_published_mutation
BEFORE UPDATE OR DELETE ON app.label_template_versions
FOR EACH ROW
EXECUTE FUNCTION app.prevent_published_template_version_mutation();

CREATE FUNCTION app.guard_print_batch_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
    (OLD.status = 'reserved' AND NEW.status IN ('generating', 'canceled'))
    OR (OLD.status = 'generating' AND NEW.status IN ('artifact_ready', 'generation_failed'))
    OR (OLD.status = 'generation_failed' AND NEW.status IN ('generating', 'canceled'))
    OR (OLD.status = 'artifact_ready' AND NEW.status IN ('printing', 'voided'))
    OR (OLD.status = 'printing' AND NEW.status IN ('completed', 'voided'))
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Invalid print batch status transition.',
      CONSTRAINT = 'print_batches_status_transition';
  END IF;

  IF OLD.status IN ('artifact_ready', 'printing', 'completed', 'voided')
     AND (
       NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
       OR NEW.artifact_object_key IS DISTINCT FROM OLD.artifact_object_key
       OR NEW.artifact_sha256 IS DISTINCT FROM OLD.artifact_sha256
       OR NEW.artifact_size_bytes IS DISTINCT FROM OLD.artifact_size_bytes
       OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Formal print artifacts are immutable.',
      CONSTRAINT = 'print_batches_artifact_immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER print_batches_guard_transition
BEFORE UPDATE ON app.print_batches
FOR EACH ROW
EXECUTE FUNCTION app.guard_print_batch_transition();

CREATE FUNCTION app.guard_qr_print_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.print_status IS DISTINCT FROM NEW.print_status AND NOT (
    (OLD.print_status = 'legacy_unclassified' AND NEW.print_status IN ('available', 'voided'))
    OR (OLD.print_status = 'available' AND NEW.print_status = 'reserved')
    OR (OLD.print_status = 'reserved' AND NEW.print_status IN ('available', 'artifact_generated'))
    OR (OLD.print_status = 'artifact_generated' AND NEW.print_status IN ('printed', 'voided'))
    OR (OLD.print_status = 'printed' AND NEW.print_status = 'voided')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Invalid QR print status transition.',
      CONSTRAINT = 'qr_codes_print_status_transition';
  END IF;

  IF OLD.print_batch_id IS DISTINCT FROM NEW.print_batch_id AND NOT (
    OLD.print_status = 'available'
    AND NEW.print_status = 'reserved'
    AND OLD.print_batch_id IS NULL
    AND NEW.print_batch_id IS NOT NULL
  ) AND NOT (
    OLD.print_status = 'reserved'
    AND NEW.print_status = 'available'
    AND OLD.print_batch_id IS NOT NULL
    AND NEW.print_batch_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'QR print batch assignment is immutable after artifact generation.',
      CONSTRAINT = 'qr_codes_print_batch_assignment';
  END IF;

  IF NEW.print_status IS DISTINCT FROM OLD.print_status
     AND NEW.print_status_updated_at IS NOT DISTINCT FROM OLD.print_status_updated_at THEN
    NEW.print_status_updated_at = CURRENT_TIMESTAMP;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER qr_codes_guard_print_transition
BEFORE UPDATE OF print_status, print_batch_id ON app.qr_codes
FOR EACH ROW
EXECUTE FUNCTION app.guard_qr_print_transition();
