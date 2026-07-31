# JSON to PostgreSQL Importer Specification v1

## 1. Scope

The importer is a future one-time migration tool. Phase 1 specifies behavior only; it does not implement the tool or connect to a database.

The importer:

- Reads one explicitly named JSON backup.
- Never edits, renames, or rewrites the source file.
- Supports dry-run and staging import.
- Preserves stable business IDs.
- Fails closed on unknown fields or ambiguous relationships.
- Produces aggregate and redacted reports only.

It does not read the live production `db.json`. Production analysis uses a verified backup copy during a later controlled phase.

## 2. Invocation contract

Future apply mode requires:

- Explicit input path.
- Expected source SHA-256.
- Explicit target environment/schema.
- Explicit `--apply`; default is dry-run.
- Backup confirmation and maintenance-window confirmation for final production import.
- A new `import_run_id` for every attempt.

The report shows a sanitized source label, never an unnecessary full production path.

## 3. Input parsing

1. Read bytes once and calculate SHA-256.
2. Require the expected hash to match.
3. Decode UTF-8 with optional BOM.
4. Reject invalid JSON, invalid Unicode/control characters, non-object root, or unsupported schema.
5. Validate the top-level allowlist.
6. Validate per-entity and `qr_codes` field allowlists.
7. Do not trim or rewrite user-authored content while validating it.

Unknown top-level or entity fields produce blocking anomalies. Empty historical placeholders are classified but not silently promoted into active tables.

## 4. Dry-run pipeline

Dry-run performs no PostgreSQL writes and reports:

- Source hash and schema fingerprint.
- Collection counts.
- Recognized and unknown field counts.
- Duplicate user ID, phone, OpenID, account ID, QR ID, order ID/no, payment transaction ID, and proof operation ID.
- Missing account, batch, QR, product, order, record, and proof references.
- QR lifecycle/content combination anomalies.
- Record/co-creation ownership anomalies.
- Invalid timestamps, money, quantity, status, and hash formats.
- `blockchain_hash`/`manifest_hash` conflicts.
- Local comment/QC/payment legacy ID collisions in their intended scopes.
- Data disposition totals: migrate, archive, omit, Redis, OSS.

Every anomaly is categorized as blocking or advisory.

## 5. Source mapping and legacy IDs

- Account ID, QR ID, product ID, order ID, order number, batch ID, and known provider operation IDs preserve exact values.
- Numeric user/operator/log IDs are preserved when positive, unique, and representable; identity sequences are reset above the imported maximum.
- Non-numeric global IDs receive a surrogate key and retain `legacy_id`.
- Locally scoped comment IDs retain `legacy_comment_id` with unique
  co-creation scope. Every comment, including deleted comments, receives the
  zero-based original JSON array index as `source_position`.
- Legacy payment and QC IDs retain `legacy_id` with the relevant scope or import-run provenance.
- Empty strings are not automatically treated as valid identifiers.

## 6. Import order

| Step | Input | Output | Required validation |
|---|---|---|---|
| 1 | Meta/source | import run | Source hash unique; schema recognized |
| 2 | Accounts | accounts | IDs unique; status/created_from valid |
| 3 | Users/admins | users/operators | Identity uniqueness; account references; password hashes only |
| 4 | Batches/products | batch/catalog tables | IDs and product children valid |
| 5 | QR base fields | qr_codes | All fields classified; IDs/tokens unique |
| 6 | QR content fields | records | Activated and co-creating content mapped once |
| 7 | QR co-creation | co-creations/comments | Owner/account references and local IDs valid |
| 8 | QC logs/summary | quality_check_logs | No duplicate synthetic event |
| 9 | Orders | orders | Account/product relations; amounts recompute |
| 10 | Payment logs | transactions/events | Order relation; transaction idempotency; sanitized metadata |
| 11 | Proof/archive fields | proofs/archives/attempts | Hash aliases, operation IDs, status relations valid |
| 12 | Miniapp/audit | content/audit tables | JSON shape and redaction valid |
| 13 | Finalization | sequences/constraints | Sequence reset; deferred constraints validated |

For the current small-data profile, a staging import should use one transaction. If future volume requires chunks, each chunk is tied to an import run and cannot make a partially validated run eligible for cutover.

## 7. QR mapping rules

- `unactivated` QR: no record or co-creation row unless an anomaly is reported.
- `co_creating` QR: exactly one unsealed record and one active co-creation.
- `activated` QR: exactly one sealed record; co-creation may be absent or finalized.
- Record ownership comes from `account_id`; co-creation ownership comes from `co_creation_owner_account_id`.
- Phone fields are snapshots only.
- Deleted comments are imported with deleted status, timestamps, and their
  original source position. Positions are not compacted after deletion.
- Embedded QC summary is reconciled with QC logs. An unmatched summary may become one synthetic legacy event with explicit provenance.
- `manifest_hash` is canonical. A lone `blockchain_hash` can seed it; unequal non-empty values block import.

## 8. Idempotency and import records

- `import_runs.source_sha256` is unique for formal imports.
- Repeating a formal import of the same source hash is rejected, not silently upserted.
- Development repetition uses a fresh disposable schema.
- Every inserted row records import provenance where needed through `import_run_id` or a mapping table during migration.
- A failed staging transaction leaves no imported business rows.
- Import reports are reproducible for the same source bytes and importer version.

## 9. Anomaly report

Allowed fields:

- Import run ID.
- Severity and stable anomaly code.
- Entity type.
- Legacy ID hash or safe non-sensitive business ID where appropriate.
- Field name.
- Candidate count.
- Blocking flag.
- Aggregate totals.

Forbidden fields include full phone, OpenID, UnionID, address, user text, image/signed URL, token, password hash, and payment/provider payload.

Representative blocking codes:

- `UNKNOWN_TOP_LEVEL_FIELD`
- `UNKNOWN_QR_FIELD`
- `DUPLICATE_IDENTITY`
- `MISSING_ACCOUNT_REFERENCE`
- `INVALID_QR_LIFECYCLE`
- `RECORD_OWNER_MISSING`
- `ORDER_AMOUNT_MISMATCH`
- `PAYMENT_IDEMPOTENCY_CONFLICT`
- `MANIFEST_HASH_CONFLICT`
- `PROOF_OPERATION_DUPLICATE`

## 10. Validation report

The post-import validator compares source classification with PostgreSQL:

- Account, identity, QR, sealed record, co-creation draft, comment, product, order, payment, proof, and archive counts.
- Account-to-identity and business ownership edges.
- QR lifecycle distribution.
- Record and co-creation one-to-one rules.
- Order quantity, unit amount, row amount, and aggregate amount.
- Payment status/amount/transaction uniqueness.
- Image object key and image SHA-256.
- Manifest hash, operation ID, proof status, and archive state.
- Sequence next values and all foreign-key/unique/check constraints.

Counts for `records` are reported separately as sealed records and co-creation drafts so the current JSON model is not misinterpreted.

## 11. Shadow-read validation

Shadow reads do not write PostgreSQL and JSON together.

1. A domain service reads from the current source and PostgreSQL repository.
2. Both results are converted to the same canonical DTO.
3. Non-deterministic fields such as signed URLs, display translations, and generated expiry values are excluded.
4. Sensitive values are compared in memory and represented only by mismatch code/hash in reports.
5. Differences are recorded; no store is automatically repaired.

Critical account ownership, record ownership, order amount/status, payment state, and proof state require 100% agreement. With the expected pre-launch data size, all rows should be compared rather than sampled.

## 12. Maintenance-window cutover

1. Announce and enter a write-free maintenance window.
2. Confirm the application and all scripts have stopped JSON writes.
3. Create and verify the final immutable JSON backup and SHA-256.
4. Create a PostgreSQL backup/restore point.
5. Run final dry-run against the exact source hash.
6. Import into the target schema.
7. Run all validation and shadow-read checks.
8. Apply GO/NO-GO decision.
9. Switch the database driver/configuration.
10. Run authentication, QR read/save, co-creation, order, payment simulation/callback, and proof-state smoke checks.
11. Record the first accepted PostgreSQL write time. This is the rollback boundary.

## 13. GO/NO-GO

GO requires all of the following:

- Every source object and field is classified.
- Unknown field count is zero.
- Duplicate identity and stable ID count is zero.
- Missing foreign-key count is zero.
- QR, sealed record, draft record, co-creation, and comment counts agree.
- Order rows and aggregate integer-cent amounts agree.
- Payment status, amount, and unique transaction identity agree.
- Image object key/hash and proof operation/hash/status agree.
- All PostgreSQL constraints validate.
- Importer dry-run is deterministic and staging import is repeatable in a fresh schema.
- PostgreSQL backup restore has been tested.
- No JSON writer is active.
- Critical shadow DTO comparison is 100% equal.

Failure of any core condition is NO-GO. Advisory anomalies require an explicit signed decision and cannot include ownership, money, identity, proof, or unknown-field issues.

## 14. Rollback

- Before the first accepted PostgreSQL write, configuration can return to the verified final JSON backup.
- After the first PostgreSQL write, switching back to the old JSON file is prohibited because it would lose new data.
- Post-write rollback means deploying the previous compatible application version while retaining PostgreSQL, or stopping writes and using a separately reviewed PostgreSQL-to-JSON exporter.
- Prefer forward repair once PostgreSQL accepts production writes.
- The cutover record includes final JSON hash, import run ID, PostgreSQL backup ID, application version, first-write time, and decision owner.

## 15. Phase 2B-1 implementation status

Phase 2B-1 implements a read-only analyzer at `scripts/database/import-dry-run.js`.

```text
node scripts/database/import-dry-run.js \
  --input=<explicit-json-path> \
  --expected-source-sha256=<sha256> \
  --dry-run \
  --format=json
```

- The CLI has no apply, staging, database URL, repository, auto-fix, or ignore-error mode.
- Exit code `0` means READY, `2` means a completed but BLOCKED audit, and `1` means input/parse/program failure.
- The analyzer returns `{ report, plan }` internally. The report is redacted; the plan may contain import-ready rows but exists only in memory and is never emitted by the CLI.
- Reader, mapping, validator, report, and CLI modules are deliberately small and migration-specific. They are not a general ETL or plugin framework.
- Input bytes are hash-verified, decoded once for parsing, and checked again for hash/mtime/size stability before completion.
- Source fields and dispositions are recorded in [source-inventory-v1.md](source-inventory-v1.md).
- Phase 2B-1 does not import `pg`, the pool, repositories, or the migration runner and does not connect to PostgreSQL.
- PostgreSQL staging writes remain prohibited until a separate Phase 2B-2 review approves the mapping, QR relation conservation, anomaly blocking, and report privacy.

## 16. Phase 2B-2 staging writer status

Phase 2B-2 adds a staging-only writer and verifier without changing the application data source.

```text
node scripts/database/import-staging.js \
  --input=<explicit-json-path> \
  --expected-source-sha256=<sha256> \
  --target=staging \
  --apply-staging \
  --staging-confirmed
```

Safety contract:

- The target must be a separately provisioned PostgreSQL database whose name ends in `_staging` or `_test`. The schema remains the migration-defined `app` schema.
- The CLI does not create or drop a database/schema and is disabled under `NODE_ENV=production`.
- Phase 2B-1 analyzes the exact source snapshot first. `READY`, zero blocking anomalies, disposition conservation, and count conservation are mandatory.
- `writer.js` accepts only `{ plan, transactionContext }`. It does not create a pool/client, import connection configuration, or issue transaction control SQL.
- Business rows use IDs, timestamps, and mapped values from the plan. The writer does not call clocks, UUID generators, or random functions for historical business fields.
- Import-run IDs and run start/completion timestamps are migration control metadata and may be generated at execution time.
- Technical identity keys may be assigned by PostgreSQL only where the source has no stable identifier and the target schema explicitly defines an identity column. Existing positive legacy identity values are inserted explicitly.
- Product image/tag timestamps are inherited from their source product so those rows do not depend on a database clock.
- One serializable business transaction performs the import, identity-sequence reset, exact mapped-row comparison, relation checks, lifecycle checks, amount checks, source recheck, and successful run transition.
- A transaction advisory lock serializes business imports. After obtaining it, the importer rechecks that all business tables are empty, preventing a waiting request from applying a stale assumption.
- Import SQL uses fixed table/column allowlists and parameterized values. Upsert, conflict-ignore, repair, and overwrite behavior are prohibited.
- On business failure, PostgreSQL rolls back all business rows. Only the control `import_runs` row and a redacted `import_anomalies` row remain for diagnosis.
- A repeated source SHA-256 is blocked. Repetition for testing requires a fresh disposable database.

Verification contract:

- Every imported table is compared in memory against the plan using fixed mapped columns; sensitive values are never printed.
- Explicit historical values in identity columns are verified separately.
- Account, record, co-creation, comment, order, payment, proof, and archive
  relationships are checked before commit. Comment positions must be
  non-negative, unique within each co-creation, and contiguous from zero for
  the imported source array.
- QR lifecycle relationships, order totals, payment amounts, and proof operation uniqueness are checked before commit.
- Identity sequences are reset above imported/generated values before the transaction is accepted.

Implementation and transaction-fake tests are complete. Real execution against PostgreSQL 15+ remains a mandatory NO-GO gate because this workstation has no disposable PostgreSQL runtime. Until real migration, rollback, constraint, count, value, and sequence checks pass, Phase 2C repository work must not begin.
