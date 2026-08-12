# PostgreSQL Migration Phase 1

## Status

This directory is the design baseline for replacing the runtime JSON database with PostgreSQL.

- Original design baseline commit:
  `def67d8404bb7ccfe45a7e3dccb830367378ccba`.
- At that baseline, the working tree contained uncommitted Batch 1 JSON safety
  changes. The phase-specific sections below preserve that historical context.
- The model in these documents comes from application code, migration logic, routes, services, and test fixtures.
- Production `db.json` is not an input to Phase 1.

## Current submission baseline

The cumulative implementation was reviewed and committed in dependency order:

| Group | Commit | Purpose |
|---|---|---|
| A | `33e4eac` | JSON database consistency |
| B | `ddb44e0` | PostgreSQL schema and connection foundation |
| C | `2978cd4` | Staging importer and Migration 002 |
| D | `5adca2c` | Repository foundation |
| E | `aa613c6` | Public QR Candidate, comparator, and gap audit |

Group E commit tree
`33e7e9999d883b68a6e0d8d176a3640929ccaf2a` exactly matches the
independently reviewed candidate tree. That tree passed 154/154 offline tests.
Its manual Public QR integration test passed 1/1 against a disposable
PostgreSQL 15.18 instance, with JSON/PostgreSQL DTO mismatch count zero. The
instance stopped cleanly and its temporary data was removed.

Current status:

- `WORKTREE_AUDIT_STATUS=PASS`
- `COMMIT_BOUNDARY_EXECUTION=COMPLETE`
- `ADAPTER_COVERAGE=COMPLETE`
- `OFFLINE_PG_VALIDATION=PASSED`
- `PUBLIC_QR_INTEGRATION_STATUS=PASSED`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

JSON remains the only runtime business-data source. PostgreSQL is not imported
by current routes or services, and no Shadow Read, dual read, dual write,
production PostgreSQL connection, cutover, or deployment has occurred.

## Goal

Move the persistence boundary from:

```text
route -> dbService -> db.json
```

to:

```text
route -> domain service -> repository -> PostgreSQL
                         -> outbox job -> external service
```

Phase 1 defines the target model and contracts. Phase 2A adds a reviewable initial SQL migration, explicit connection and transaction helpers, and a guarded migration runner. None of these components are imported by the current business runtime.

## Phase 2A-1 status

- `database/migrations/001_init_schema.sql` defines the initial PostgreSQL 15+ schema in the dedicated `app` schema.
- `src/server/database/config.js` parses and redacts PostgreSQL environment configuration without importing a driver or opening a connection.
- Plain `pg` is the recommended future runtime driver, but no dependency has been installed.
- No connection pool or migration runner exists yet.
- The migration has been executed against a disposable local PostgreSQL 15.18 instance during Phase 2B-2.6 validation. It remains disconnected from business runtime code.
- No route, service, repository, or startup path is connected to PostgreSQL.
- No JSON data has been imported or modified.
- The JSON database remains the only runtime persistence source until an explicit later cutover phase.
- Driver and migration-runner decisions are recorded in [phase-2a-decisions.md](phase-2a-decisions.md).

## Phase 2A-2 status

- `pg` 8.22.0 is installed as the only direct PostgreSQL dependency.
- `connection.js` creates a pool only when explicitly called; importing the module does not connect.
- `transaction.js` provides callback-scoped BEGIN/COMMIT/ROLLBACK behavior without domain logic.
- `healthCheck.js` reports only connection status, latency, and the PostgreSQL server version.
- `scripts/database/migrate.js` defaults to dry-run, validates canonical SHA-256 checksums, rejects changed or unknown applied migrations, and uses a session advisory lock for apply mode. Canonicalization changes only CRLF bytes to LF, while `.gitattributes` pins migration SQL files to LF at checkout.
- The runner owns each migration transaction and records the migration in `app.schema_migrations` before the same commit.
- Phase 2A-2 rejects production migration targets. It does not create databases, roles, extensions, or grants.
- Unit and static validation are implemented in `tests/database-infrastructure.test.js`.
- Real-server schema execution has been completed against a disposable local PostgreSQL 15.18 instance. The validation cluster and databases were removed after the run.
- PostgreSQL is still not connected to routes, services, repositories, startup, or business traffic. No JSON data has been migrated.

## Core decisions

1. `accounts` is the stable business principal.
2. `users` stores login identities such as phone and OpenID. A user row is not a business account. Record, co-creation, and order ownership must resolve through `accounts`.
3. Existing account IDs, QR IDs, order IDs, order numbers, and other stable business identifiers are preserved.
4. `qr_codes.lifecycle_status` is the single high-level QR business lifecycle. It does not represent proof, payment, archive, quality-check, or job state.
5. Valid QR transitions are:
   - `unactivated -> activated`
   - `unactivated -> co_creating -> activated`
6. Record content has one source of truth in `records`. Finalizing co-creation seals the existing record row; it does not create a duplicate record.
7. Repository methods do not commit cross-domain transactions. Domain services use a `TransactionContext`/`UnitOfWork` to control commit and rollback.
8. JSON and PostgreSQL will not be updated with naive dual writes. Shadow reads compare normalized DTOs only.
9. WeChat Pay, OSS, chain proof providers, and QR image generation are outside database transactions. Idempotency keys and outbox jobs connect durable state to those side effects.
10. Session, SMS verification codes, and other TTL state belong in Redis in a later phase.
11. Image, manifest, certificate, and archive files remain in OSS. PostgreSQL stores object keys, hashes, and durable state.

## Documents

- [schema-v1.md](schema-v1.md): PostgreSQL tables, types, constraints, indexes, lifecycle, and JSON field mapping.
- [repository-contracts-v1.md](repository-contracts-v1.md): repository responsibilities, method contracts, locks, errors, and service transactions.
- [importer-spec-v1.md](importer-spec-v1.md): read-only JSON input, dry-run, mapping, anomaly reporting, validation, cutover, and rollback.
- [phase-2a-decisions.md](phase-2a-decisions.md): PostgreSQL target, driver recommendation, identifier strategy, migration execution policy, and runtime boundary.

## Data disposition

| Current data | Target |
|---|---|
| Accounts, identities, QR, records, co-creation, products, orders, payments, proof metadata | PostgreSQL |
| `content_pages`, `banners` with no runtime callers | Archive, then omit unless a production-copy audit proves active data |
| `meta.next_*` and migration markers | PostgreSQL sequences, `schema_migrations`, and `import_runs` |
| Existing `audit.log` | Read-only archive; new audit events use PostgreSQL |
| Sessions, SMS codes, rate-limit TTL state | Redis in a later phase |
| Images, manifests, certificates, archive documents | OSS |

## Privacy boundary

Design and validation reports must not contain full phone numbers, OpenIDs, addresses, image URLs, payment provider payloads, tokens, or user-authored text. Sensitive differences are represented by data type, stable hash prefix, legacy identifier hash, and count.

## Phase sequence

1. Phase 1: approve these design documents.
2. Phase 2A: create SQL migrations, the connection/transaction layer, and a guarded runner without routing production traffic; complete disposable PostgreSQL validation before Phase 2B.
3. Phase 2B: implement the importer, dry-run, staging import, and validation report.
4. Phase 2C: implement repositories while JSON remains the runtime source.
5. Phase 2D: add normalized, read-only shadow comparisons without dual writes.
6. Phase 2E: perform the final maintenance-window import, GO/NO-GO review, and PostgreSQL cutover.
7. Post-cutover: observe PostgreSQL, retire runtime JSON writes, and archive legacy tooling.

No later phase starts until the preceding phase has an explicit review result.

## Phase 2B-1 status

- A migration-specific JSON reader, source inventory, mapper, validator, redacted report, and fixed dry-run CLI are implemented.
- The source must be an explicitly named non-runtime JSON file with an expected SHA-256.
- The importer produces an in-memory plan and a sanitized report from the same byte snapshot.
- Unknown fields, ambiguous identities, broken references, invalid lifecycle combinations, and count-conservation failures block readiness.
- No PostgreSQL client, connection, repository, staging write, or business runtime integration is used.
- No JSON data has been migrated. Phase 2B-2 remains gated on focused review of the source inventory and dry-run behavior.

## Phase 2B-2 status

- `scripts/database/import-staging.js` is an explicit staging-only CLI. It requires an input file, expected source SHA-256, `--target=staging`, `--apply-staging`, and `--staging-confirmed`.
- Staging import is rejected under `NODE_ENV=production` and unless the explicitly configured database name ends in `_staging` or `_test`.
- Staging uses a separate disposable database with the fixed `app` schema. The importer does not create or drop databases, schemas, roles, or grants.
- `writer.js` accepts only the in-memory Phase 2B-1 plan and a caller-provided transaction context. It does not create a pool/client or manage transactions.
- Historical business IDs, timestamps, and mapped values are written explicitly from the plan. Only import control rows use execution-time timestamps; identity columns with no source identifier remain technical database-generated keys.
- A control transaction records the import run. One serializable business transaction acquires an advisory transaction lock, rechecks migrations and staging emptiness, imports all rows, resets identity sequences, compares imported rows with the plan, validates relationships, and marks the run passed.
- A failed business transaction rolls back all imported business rows. A separate control transaction marks the run failed and records only a redacted anomaly.
- The same source SHA-256 is rejected on repeat. A different concurrent source cannot import over an earlier result because the advisory lock is followed by a fresh empty-table check.
- Unit tests exercise staging gates, writer injection, deterministic business values, import order, repeated-source blocking, row verification, and rollback behavior using transaction fakes.
- PostgreSQL 15.18 migration execution, real constraint rollback, sequence insertion, duplicate-source rejection, and post-import SQL verification passed in disposable local databases during Phase 2B-2.6. No shared or production database was used.
- PostgreSQL remains disconnected from routes, services, repositories, startup, and business traffic. No production or staging data has been imported during implementation.

## Phase 2B-2.6 migration correction status

- `001_init_schema.sql` is still untracked and has no entry in Git history. The only recorded executions used disposable local PostgreSQL databases that were deleted after validation; no persistent or shared database execution is recorded. On that evidence, the initial migration is corrected in place before its first release rather than adding a compatibility migration.
- The staging failure exposed a contract mismatch: the importer produces full 64-character lowercase SHA-256 audit reference hashes while `audit_events.actor_reference_hash` and `audit_events.entity_reference_hash` allowed only 32 characters.
- Both audit reference columns now use `char(64)` with explicit lowercase hexadecimal checks. Short redacted report references, provider transaction hashes, operation IDs, and other non-SHA identifiers keep their separate semantics.
- This correction does not change the importer mapping, business runtime, JSON source, routes, services, or repository integration boundary.
- PostgreSQL 15.18 validation passed in fresh disposable databases: migration apply and zero-pending rerun, checksum-drift rejection, full-fixture dry-run/import, relationship and count verification, duplicate-source rejection, late-stage rollback with zero business rows, and actual identity-sequence inserts all succeeded.
- The full fixture produced one `audit_events` row with a 64-character SHA-256 reference, covered `unactivated`, `co_creating`, and `activated` QR lifecycles, kept and deleted comments, order/payment data, proof metadata, and archive metadata. All relationship violation counts were zero.
- Real database constraint checks accepted 64-character lowercase hexadecimal and NULL values, and rejected 63-character, 65-character, and non-hexadecimal audit reference hashes.
- Phase 2B-2.6 and the previously pending Phase 2B-2.5 staging execution gate are complete. This does not authorize production migration or runtime cutover.

## Phase 2C-2B-2 public QR read status

- A minimal `QrBatchRepository.findById()` now supplies only the public batch
  projection required by the isolated public QR adapter.
- The existing importer, PostgreSQL writer, real repositories, adapter, and
  redacted DTO comparator passed a manual integration test against a disposable
  PostgreSQL 15.18 database using artificial fixtures only.
- Supported H5 and miniapp lifecycle cases compared with zero DTO mismatches.
  The test also verified bounded query counts and real repository SQL.
- Two compatibility issues are confirmed as data-model gaps rather than
  repository omissions: unactivated H5 disclosure state and equal-timestamp
  embedded-comment source order. They are not hidden with fallback values.
- Stable fixture URLs are compared exactly. Real external OSS signed-URL
  validation remains an external dependency gate.
- Current status is `WORK_STATUS=COMPLETED`,
  `ADAPTER_COVERAGE=PARTIAL`, `OFFLINE_PG_VALIDATION=PASSED`, and
  `RUNTIME_READINESS=NOT_READY`.
- No route, runtime database selector, shadow read, dual write, production
  database, or production JSON snapshot is involved.

## Phase 2C-2B-3 public QR gap decision status

- Code tracing confirms that new unactivated QR rows initialize
  `show_brand_disclosure` to false, while the H5 public DTO still exposes the
  QR-level source field and PostgreSQL preserves disclosure only on records.
  Historical production distribution therefore requires a read-only
  backup-copy audit before choosing a compatibility strategy.
- JSON comments retain append order for equal timestamps. The importer
  preserves a legacy comment ID but not an unconditional source position, and
  the PostgreSQL repository currently uses UUID order as its tie-breaker.
  Exact compatibility therefore requires a stable source-order decision;
  `source_position` is the recommended model.
- `SHADOW_READ_DESIGN_READY=YES`, but
  `SHADOW_READ_EXECUTION_READY=NO` and `RUNTIME_READINESS=NOT_READY`.
- Completion of this decision phase does not authorize runtime comparison.
  Any schema/importer/repository change must pass fresh staging import and
  offline DTO validation before Phase 2D Shadow Read design.

## Phase 2C-2B-4 public QR backup audit status

- `scripts/database/audit-public-qr-gap.js` accepts only an explicit absolute
  structural-export path, expected SHA-256, and `--dry-run`.
- The structural allowlist contains only lifecycle/disclosure and comment
  order evidence. Complete runtime snapshots and inputs containing identity,
  content, URL, address, token, or payment fields are rejected.
- The tool does not import `dbService`, importer, migration, PostgreSQL, or any
  file-write helper. It verifies input SHA-256, size, and raw `mtimeNs` before
  and after analysis and emits count-only JSON.
- Focused fixture tests cover CLI gates, BOM/JSON/hash handling, disclosure
  distribution, parsed-time collisions, deleted-comment exclusion,
  source-position evidence, report redaction, and input immutability.
- This tool's completion is independent from the server-side aggregation
  evidence recorded in Phase 2C-2B-5. Whether the structural audit tool was
  used on the reported snapshot is `UNKNOWN`.

## Phase 2C-2B-5 public QR audit evidence status

- Count-only evidence was reported from a read-only aggregation over a
  temporary server-side copy derived from the production JSON database. The
  live JSON database was not modified, no production PostgreSQL database was
  connected, and the complete copy was not transferred off the server.
- Evidence provenance is recorded as
  `AUDIT_EXECUTION_METHOD=SERVER_SIDE_OFFLINE_AGGREGATION`,
  `AUDIT_METHOD_VERIFIED=UNKNOWN`, `AUDIT_SCOPE_VERIFIED=PARTIAL`,
  `AUDIT_INPUT_INTEGRITY=PARTIAL`, and
  `AUDIT_EVIDENCE_CONFIDENCE=PARTIAL`.
- Execution time, snapshot creation time, and server revision are `UNKNOWN`.
  Temporary-copy cleanup is `PENDING`. The documented source reference is
  `source_location=temporary-server-side-copy` with the non-sensitive checksum
  prefix `f263df13b5c1`.
- Among 48 unactivated QR rows, disclosure was false for all 48, with zero
  true, missing, or invalid values. The result is
  `GAP_1_DATA_EVIDENCE=NO_HISTORICAL_TRUE_FOUND`; it does not close the
  compatibility gap.
- Across two QR/co-creations with comments, the snapshot contained four
  comments: three effective and one deleted. No timestamp was missing or
  invalid, and no equal parsed-time group was reported. The result is
  `GAP_2_DATA_EVIDENCE=NO_EQUAL_TIMESTAMPS_FOUND`; it does not establish UUID
  ordering as the long-term compatibility rule.
- Current status remains `TOOL_STATUS=COMPLETED`, `AUDIT_INPUT=AVAILABLE`,
  `AUDIT_EXECUTION_STATUS=COMPLETED`, `WORK_STATUS=COMPLETED`,
  `ADAPTER_COVERAGE=PARTIAL`, `OFFLINE_PG_VALIDATION=PASSED`,
  `SHADOW_READ_DESIGN_READY=YES`, `SHADOW_READ_EXECUTION_READY=NO`, and
  `RUNTIME_READINESS=NOT_READY`.
- The next decision sequence begins with Phase 2C-2B-6A recommendations.
  Product approval must follow before either compatibility contract is frozen
  or any schema/importer/repository change is authorized.

## Phase 2C-2B-6A public QR compatibility recommendations

- This phase records recommendations only. It does not provide product
  approval, freeze a compatibility contract, or authorize implementation.
- Gap 1 was re-traced after confirming that the unactivated page contains a
  user-controlled disclosure switch. The earlier `FIX_FALSE_BY_RULE`
  recommendation is superseded by `RECORD_LEVEL_PERSISTENCE`.
- The batch default only initializes the switch. Direct save and co-creation
  start both persist the submitted boolean and a submit-time batch disclosure
  text snapshot; co-creation finalize preserves those values. Later H5 and
  miniapp views render brand information only when the saved boolean is true
  and the saved snapshot is non-empty.
- PostgreSQL already models this durable choice correctly on `records`, and
  the importer creates that record for both `co_creating` and `activated`
  aggregates. Gap 1 therefore requires no QR-level schema, migration,
  importer, or repository field.
- The remaining Gap 1 work is an H5 unactivated DTO compatibility rule:
  preserve an always-present false boolean without treating it as a persisted
  user choice. Miniapp must preserve its current field omission.
- Gap 2 recommends `SOURCE_POSITION_REQUIRED`: preserve each historical
  comment's zero-based JSON array position, retain positions for deleted
  comments without renumbering, require uniqueness within each co-creation,
  exclude deleted rows from the public DTO, and order visible comments by
  `created_at DESC, source_position ASC`.
- New-comment position allocation is a later write-transaction concern and is
  not implemented here.
- Current status is
  `COMPATIBILITY_CONTRACT_STATUS=PRODUCT_DECISION_REQUIRED`,
  `IMPLEMENTATION_AUTHORIZED=NO`, `IMPLEMENTATION_REQUIRED=UNDECIDED`,
  `OFFLINE_REVALIDATION_REQUIRED=NO`, `ADAPTER_COVERAGE=PARTIAL`,
  `SHADOW_READ_DESIGN_READY=YES`, `SHADOW_READ_EXECUTION_READY=NO`, and
  `RUNTIME_READINESS=NOT_READY`.
- If both recommendations are explicitly approved, Phase 2C-2B-7 may be
  authorized to make the minimum schema/migration/importer/repository changes
  and repeat PostgreSQL staging and offline DTO validation. Approval does not
  authorize direct Shadow Read execution.

## Phase 2C-2B-7 public QR minimum compatibility implementation

- Both compatibility recommendations were approved for offline
  implementation.
- H5 unactivated responses now keep an explicit
  `show_brand_disclosure=false`; miniapp preserves field omission. Saved
  disclosure choices remain record-level data for `co_creating` and
  `activated`.
- `002_add_comment_source_position.sql` adds a zero-based, non-negative
  comment source position with per-co-creation uniqueness. It refuses to
  backfill an already populated PostgreSQL comments table because physical or
  UUID order cannot reconstruct JSON history.
- The importer maps every original array index, including deleted comments,
  and verification enforces contiguous positions. Repository reads no longer
  use UUID tie-breaking; the adapter emits visible comments in
  `created_at DESC, source_position ASC` order without exposing the internal
  field.
- Migration rollback, fresh import, idempotent migration replay, relationship
  verification, and H5/miniapp DTO equality were exercised against a
  disposable PostgreSQL 15.18 database.
- Current status is `WORK_STATUS=COMPLETED`,
  `COMPATIBILITY_CONTRACT_STATUS=FROZEN`,
  `IMPLEMENTATION_STATUS=COMPLETED`, `ADAPTER_COVERAGE=COMPLETE`,
  `OFFLINE_PG_VALIDATION=PASSED`, `SHADOW_READ_DESIGN_READY=YES`,
  `SHADOW_READ_EXECUTION_READY=NO`, and `RUNTIME_READINESS=NOT_READY`.
- JSON remains the only runtime data source. Phase 2D may design Shadow Read
  gates but may not enable runtime comparison from this status alone.

## Phase 2D-0 workspace and Shadow Read baseline

- The cumulative uncommitted worktree has been classified in
  [phase-2d-0-workspace-baseline.md](phase-2d-0-workspace-baseline.md).
- PostgreSQL connection, repository, Adapter, and comparator modules are not
  imported by server startup, routes, middleware, or existing business
  services. JSON remains the sole runtime data source.
- `WORKTREE_AUDIT_STATUS=PARTIAL` because stage attribution is reconstructed
  from code and documents rather than stage-specific Git commits. No
  unintended PostgreSQL runtime integration was found.
- The migration fileset contains the unchanged `001` and additive `002` with
  recorded SHA-256 values. Phase 2D-0 did not connect to a database; the prior
  disposable PostgreSQL 15.18 `pending=0` result remains inherited evidence.
- Recommended future observation occurs after the existing H5/miniapp JSON
  presenter has built the final DTO. Baseline always determines the response;
  Candidate comparison must be asynchronous, bounded, and value-free.
- URL resolver equivalence, transaction lifetime, mismatch retention,
  sampling, timeout, circuit breaker, and cumulative commit boundaries remain
  execution gates.
- Current status: `SHADOW_READ_DESIGN_READY=YES`,
  `SHADOW_READ_EXECUTION_READY=NO`, and `RUNTIME_READINESS=NOT_READY`.

## Phase 2D-0.5 commit boundary readiness

- The 52 uncommitted paths are fully classified: five tracked modifications
  and 47 untracked files. The staging area remains empty.
- The dependency-aware sequence is Batch 1 JSON safety, PostgreSQL foundation,
  importer/staging plus Migration 002, repositories plus infrastructure-test
  registration, Public QR Candidate/offline tests, and consolidated docs.
- `package.json` is the only required hunk split: Group B receives `pg` and the
  migration commands; Group D receives the `npm test` registration after all
  top-level test imports exist.
- The final importer files remain with Migration 002, and final co-creation
  repository projections follow them. This preserves `source_position`
  consistency without recreating historical intermediate files.
- Current status is `CLASSIFICATION_STATUS=COMPLETE`,
  `COMMIT_BOUNDARY_PLAN_STATUS=READY`, `RUNTIME_PATH_STATUS=UNCHANGED`, and
  `WORKTREE_AUDIT_STATUS=PARTIAL`.
- `PARTIAL` remains correct until each group is staged, independently checked
  out from its declared parent, tested, reviewed, and committed. The next step
  is Phase 2D-0.6 submission-boundary review, not Shadow Read implementation.

## Phase 2D-0.6 commit boundary result

Groups A through E were staged and committed in the declared dependency order.
The PostgreSQL implementation groups are independently represented in Git, and
the remaining documentation group contains no runtime code.

- `CLASSIFICATION_STATUS=COMPLETE`
- `COMMIT_BOUNDARY_PLAN_STATUS=COMPLETE`
- `COMMIT_BOUNDARY_EXECUTION=COMPLETE`
- `RUNTIME_PATH_STATUS=UNCHANGED`
- `WORKTREE_AUDIT_STATUS=PASS`

This result closes the accumulated-worktree classification gate. It does not
close the separate Shadow Read execution gates documented in
[phase-2d-0-workspace-baseline.md](phase-2d-0-workspace-baseline.md).

## Phase 2D-1 Public QR Shadow Read design

- [shadow-read-design-v1.md](shadow-read-design-v1.md) freezes the baseline,
  Candidate, freshness, resolver, comparator, sampling, telemetry, and rollback
  boundaries for a future Public QR observer.
- The real insertion point is after the existing H5 or miniapp JSON presenter
  creates its final `data` DTO. Candidate work may start only from a no-throw,
  bounded response-finish callback; JSON remains the only response source.
- Initial eligibility requires the source hash captured with the JSON baseline
  read to equal the source SHA-256 of a passed PostgreSQL import. Stale or
  unversioned data is skipped and never counted as a mismatch.
- Candidate database reads must finish before image or certificate resolution.
  Production-equivalent channel resolvers remain an execution gate.
- Public comments remain capped by the existing 12-comment business invariant;
  the future SQL query must fetch at most 13 and fail the Candidate on overflow
  rather than truncating silently.
- `SHADOW_READ_DESIGN_STATUS=COMPLETE`, `SHADOW_READ_DESIGN_READY=YES`,
  `SHADOW_READ_GO_NO_GO=GO`, and
  `SHADOW_READ_GO_SCOPE=DEFAULT_OFF_IMPLEMENTATION_ONLY`.
- `SHADOW_READ_EXECUTION_READY=NO` and `RUNTIME_READINESS=NOT_READY` remain
  unchanged. No observer, runtime switch, PostgreSQL request traffic, dual
  read, dual write, or deployment was added in this phase.

## Production snapshot compatibility gate

- The first server-side dry run against a fixed, hash-verified JSON snapshot
  remained read-only and correctly blocked import. Aggregate audit identified
  40 matching legacy proof aliases that are not SHA-256, two uniquely
  recoverable missing account links, and one pair of distinct kept comments
  belonging to the same account.
- Migration `003_preserve_legacy_import_evidence.sql` preserves the non-SHA
  proof value separately and records later historical same-account comments as
  internal legacy exceptions. It does not modify migrations `001` or `002`.
- Account recovery is importer-only and requires one exact phone-to-account
  match through the existing identity data. Runtime authorization never uses
  this fallback.
- The original JSON bytes and source SHA-256 remain unchanged. Importer reports
  expose only redacted aggregate anomalies.
- Migration `003` has canonical checksum
  `75d6f26c353f30ef9ca10f215d0d8fc7855866ee60bcf8ab4f0b5579693ad757`;
  migrations `001` and `002` remain unchanged.
- Local validation passed for the focused PostgreSQL 15.18 legacy import and
  full Public QR/Shadow integration paths. Both disposable databases were
  stopped and removed. The server deployed that revision, applied `003`, and
  repeated the dry-run against the unchanged audited snapshot before its first
  staging write.
- `SHADOW_READ_EXECUTION_READY=NO`, `RUNTIME_READINESS=NOT_READY`, and
  `JSON_RESPONSE_SOURCE=JSON` remain unchanged.

### Staging product compatibility follow-up

- The first server-side staging write rolled back in full when the audited
  historical product value `buy_type=copy_link` met the narrower original
  PostgreSQL CHECK. No business rows remained; the importer retained only its
  redacted failed-run record.
- Migration `004_allow_legacy_product_buy_type.sql` preserves `copy_link`
  alongside the current `miniapp_order` value. Runtime product writes remain
  unchanged and continue to use `miniapp_order`.
- Migration `004` has canonical checksum
  `defd92ba59fbcda677d81781eb2ac97b788ddf13e87b93163d03eb42916d60f2`;
  migrations `001` through `003` remain unchanged.
- Import validation now blocks every product buy type outside those two
  explicit values, closing the dry-run versus database-constraint gap.

### Runtime account ID allocation

- Migration `005_add_account_id_sequence.sql` adds `app.account_id_seq` for
  concurrency-safe runtime allocation of `ACC` identifiers.
- The migration rejects nonconforming historical account IDs and initializes
  the next sequence value above the largest imported numeric suffix. It does
  not rewrite imported accounts or modify migrations `001` through `004`.
- The staging importer realigns the same sequence after importing accounts, so
  a fresh database that runs migrations before the import gets the same next ID.
- Migration `005` has canonical checksum
  `6917cdec3f167230d5d31802c3ad171d1cbbb757dcf70a64ccba60fc296856e2`.
- `AccountRepository.allocateId()` formats the sequence value with the existing
  six-digit minimum width and fails closed when the database result is invalid.

### QR issuance lifecycle invariant

- Migration `006_guard_unissued_qr_lifecycle.sql` prevents new or updated QR
  rows from advancing beyond `unactivated` until their issue status is
  `issued`.
- The constraint is added as `NOT VALID`: PostgreSQL enforces it for subsequent
  writes while allowing the known legacy anomaly to remain readable until the
  source data is corrected and fully re-imported.
- JSON and PostgreSQL lifecycle services reject direct activation and
  co-creation with `QR_NOT_ISSUED`; import validation blocks the same invalid
  issue/lifecycle combination.

### Runtime QR issuance authority boundary

- `qrIssuanceAuthorityRuntime.js` is the default-off PostgreSQL authority for
  `POST /api/admin/qr/generate`. Selection requires explicit `scope=all`, the
  exact source SHA-256, and the public-QR domain SHA-256 from the same passed
  import. Static allowlists are forbidden because newly allocated IDs cannot
  be enumerated safely in advance.
- The write transaction verifies provenance and canonical migrations, takes a
  transaction advisory lock for the normalized prefix, calculates the next
  five-digit suffix, validates any referenced PostgreSQL batch, and inserts
  issued/unactivated rows with unique random access tokens. It never writes the
  JSON snapshot after PostgreSQL authority is selected.
- QR PNGs are rendered and staged before the database commit. A database or
  staging failure rolls staged files back; rendering failure preserves the
  legacy behavior of issuing the QR without an image URL. The protected image
  endpoint can resolve PostgreSQL-only tokens through the primary read runtime.
- A batch supplied during PostgreSQL issuance must already exist in
  `app.qr_batches`; a JSON-only batch fails explicitly. Creating and managing
  new batches remains a separate pre-cutover business gate if operations need
  that workflow after PostgreSQL becomes authoritative.
- The runtime is lazy, bounded, drains active issuance on shutdown, and is not
  enabled or saved in production by this implementation.

### Runtime identity write transaction boundary

- `identityWriteService.js` defines transaction-scoped PostgreSQL operations
  for idempotent web and miniapp identity creation, phone binding, and guarded
  disposal of an unreferenced temporary miniapp account.
- Canonical phone and OpenID keys use sorted transaction advisory locks. A
  disposable identity is not removed when its account or OpenID appears in
  normalized business rows or nested sanitized payment-event metadata.
- Account allocation uses `app.account_id_seq`; identity creation, binding,
  merge, and cleanup run inside one service-owned database transaction. The
  repositories remain limited to their injected transaction context.
- The transaction service is connected to the separately gated identity
  authority runtime described below. The gate remains default-off and no PM2
  production setting is enabled by this implementation.
- Unit validation and real PostgreSQL identity-write integration are complete.
  The disposable database exercised concurrent identity creation, binding,
  guarded merge, sequence allocation, and reference protection, then was
  removed without changing the staging database.

### Runtime identity authority boundary

- `identityAuthorityRuntime.js` is the single PostgreSQL authority boundary
  for H5 account creation/login, miniapp OpenID creation, phone binding and
  account merge, and authenticated identity lookup. Existing JSON behavior is
  unchanged while the boundary is not selected.
- Selection requires `IDENTITY_POSTGRES_AUTHORITY_ENABLED=true`, explicit
  `IDENTITY_POSTGRES_AUTHORITY_SCOPE=all`, and exact source and public-QR
  domain SHA-256 values from the same passed import. An allowlist is forbidden
  because partial identity authority would split new account ownership.
- Every read and write verifies source, domain, and migration provenance inside
  its database transaction before accessing or mutating identity rows. Invalid
  configuration, stale provenance, or database failure returns one generic
  account-service `503`; it never falls back to JSON after authority selection.
- The runtime is lazy, bounded to two connections, drains active operations on
  shutdown, and is not enabled or saved in production by this code change.

### Identity authentication Shadow Read

- Identity Shadow compares the completed JSON authentication result with an
  exact PostgreSQL identity/account lookup. It never shadows registration,
  phone binding, account merge, or any other write.
- Sampling is deliberately limited to `GET /api/user/me` for H5 and
  `GET /api/miniapp/user/records` for miniapp. Static files and unrelated
  authenticated traffic do not create observations.
- The Candidate starts only after the JSON response finishes, uses the source
  SHA-256 captured with the baseline read, requires an exact passed import and
  canonical migration set, and runs in a bounded read-only repeatable-read
  transaction.
- Enablement is strict and independent through
  `IDENTITY_SHADOW_READ_ENABLED=true`, an explicit
  `IDENTITY_SHADOW_READ_ALLOWLIST`, and an absolute external
  `IDENTITY_SHADOW_READ_LOG_DIR`. Missing or malformed settings fail closed.
- Logs contain only endpoint templates, channel/lifecycle labels, outcomes,
  latency buckets, mismatch paths, and value types. Phone numbers, OpenIDs,
  account IDs, identity IDs, tokens, compared values, and database secrets are
  never serialized.
- The implementation is deployed-capable but remains default-off. JSON is
  still the only response and write source; production PostgreSQL traffic,
  dual writes, and cutover are not authorized by this phase.

### QR proof outbox and isolated worker foundation

- PostgreSQL QR activation and co-creation finalization enqueue one idempotent
  `record_proof_prepare_submit` job in the same business transaction.
- The bounded worker claims with `FOR UPDATE SKIP LOCKED`, recovers stale
  leases, runs handlers outside transactions, and records only stable error
  codes before retrying or failing a job.
- The record proof job handler persists manifest, archive, proof, and attempt
  state through short transactions. Preparation and provider submission are
  injected external operations and never run while database locks are held.
- The isolated external adapter derives manifest `generated_at` from the
  durable proof creation timestamp, so a retry before database persistence
  produces the same manifest hash. It writes archive objects through the
  existing storage boundary and normalizes only known provider outcomes.
- Disabled-provider mock responses are rejected by default and cannot be
  persisted as confirmed proofs. The adapter reads no database or environment
  state and has no application-startup wiring.
- The isolated provider-result service locks proofs by provider operation ID
  and applies callback or query outcomes in one short transaction. Duplicate
  confirmation can fill missing certificate metadata, while conflicting IDs
  fail closed and stale events cannot regress a confirmed proof.
- The guarded runtime assembly requires an exact enable value, one explicit
  selection scope, exact source and public-QR domain SHA-256 values from the
  same passed import, a stable worker ID, complete real-provider credentials,
  and an HTTPS callback URL. Existing controlled validation can use
  `scope=allowlist`; stable authority uses `scope=all` and forbids an allowlist
  so newly issued QR records are covered automatically.
- The current PostgreSQL migration explicitly defers AVATA and stable proof
  processing. Its coordinated selector file sets
  `RECORD_PROOF_RUNTIME_ENABLED=false` and contains no proof scope, worker, or
  provider settings. Lifecycle transactions still enqueue durable proof work;
  those pending jobs remain available to a separate, later provider-enablement
  project. Placeholder credentials and mock confirmations are forbidden.
- Worker claims and stale-lock recovery are always scoped in SQL to the proof
  job type. Controlled mode additionally applies the QR allowlist; all scope
  passes no aggregate filter. Provider callback and query results apply the
  same scope after locking the proof row.
- Every worker pass, status inspection, and provider-result application
  requires source, domain, and canonical-migration provenance. The value-free
  worker status exposes only pending, ready, processing, stale, failed,
  succeeded, and maximum-attempt counts through the authenticated admin system
  status response.
- The runtime scheduler is serial, bounded, starts with the HTTP process only
  when its complete configuration is enabled, and closes its timer, active
  run, and pool deterministically. Deployment alone leaves it default-off.
- Interrupted attempts are closed before idempotent resubmission. Existing
  submitted or confirmed proofs do not submit twice, and imported legacy proof
  evidence fails closed instead of being overwritten.
- The worker remains disabled in PM2 and production until a separately approved
  AVATA activation. Disposable integration exercises a PostgreSQL-only newly
  issued and activated QR through all-scope claim, proof preparation,
  confirmation, acknowledgement, and backlog inspection without external OSS
  or AVATA calls.

### Public QR controlled PostgreSQL primary read boundary

- H5 `GET /api/qr/:qrId` and miniapp `GET /api/miniapp/qr/:key` now have a
  separately controlled PostgreSQL primary-read boundary. It is independent
  from Public QR Shadow Read and is disabled by default.
- Enablement requires `PUBLIC_QR_POSTGRES_READ_ENABLED=true`, the audited
  64-character lowercase `PUBLIC_QR_POSTGRES_READ_DOMAIN_SHA256`, and one
  selection scope. `PUBLIC_QR_POSTGRES_READ_SCOPE=allowlist` requires a
  canonical QR-ID-only `PUBLIC_QR_POSTGRES_READ_ALLOWLIST`; omitting the scope
  preserves this allowlist behavior for existing controlled-rollout files.
  Stable authority must instead declare `PUBLIC_QR_POSTGRES_READ_SCOPE=all`
  and omit the allowlist. Unknown scopes and an `all` scope combined with an
  allowlist fail closed.
- JSON resolves only the canonical QR ID and computes the versioned
  `public_qr_v1` domain checksum used by the selection gate. The checksum is
  built from mapped QR batches, QR rows, records, co-creation state/comments,
  and public proof/archive state. Unrelated identity, commerce, and content
  edits do not invalidate it. In allowlist scope, requests outside the list
  retain the existing JSON path and do not construct a PostgreSQL pool. The
  explicit `all` scope selects every canonical current or future QR ID.
- A selected request uses PostgreSQL as its only DTO source. Before reading
  business rows, the runtime requires the configured domain checksum in a
  passed import's checksum summary and requires the exact canonical migration
  set. Domain drift, stale imports, version drift, connection failures, and resolved-ID drift
  return a generic `503 PUBLIC_QR_READ_UNAVAILABLE`; they never fall back to
  JSON. Existing `QR_NOT_FOUND` and `QR_HIDDEN` contracts remain `404` and
  `403`.
- Reads run in bounded read-only repeatable-read transactions. Asset URL
  presentation happens after the transaction is released, and the lazily
  created pool closes with the HTTP process lifecycle.
- Deployment does not enable this boundary. Disposable integration, timed
  cohort checks, and the full 104-QR/208-route controlled production read have
  passed with JSON restored afterward. Stable enablement remains separately
  gated by the coordinated read/write cutover described below.

### QR lifecycle controlled PostgreSQL write boundary

- H5 and miniapp activation, co-creation start, comment add/delete, and final
  sealing now share an independently controlled PostgreSQL write boundary.
  It is disabled by default and preserves the JSON route when it is not
  selected.
- Enablement requires `QR_LIFECYCLE_POSTGRES_WRITE_ENABLED=true`, the audited
  64-character lowercase `QR_LIFECYCLE_POSTGRES_WRITE_DOMAIN_SHA256`, and one
  selection scope. `QR_LIFECYCLE_POSTGRES_WRITE_SCOPE=allowlist` requires a
  canonical QR-ID-only `QR_LIFECYCLE_POSTGRES_WRITE_ALLOWLIST`; omitting the
  scope preserves existing controlled-rollout behavior. Stable authority must
  explicitly use `QR_LIFECYCLE_POSTGRES_WRITE_SCOPE=all` without an allowlist.
  Unknown or conflicting scope settings fail closed.
- A selected write requires the configured import provenance and canonical
  migration set and verifies that the request account already exists in
  PostgreSQL. It executes through `qrLifecycleWriteService.js` and returns a
  DTO rebuilt from PostgreSQL. Direct activation and final sealing enqueue the
  proof outbox job in the same transaction; the legacy JSON proof submission
  path is not invoked.
- Configuration drift, stale provenance, database failures, and DTO identity
  drift fail closed as generic `503 QR_WRITE_UNAVAILABLE`. Business conflicts
  retain the existing route status and code contracts.
- The pool is lazy, bounded, and closed with the HTTP process. Deployment alone
  does not create a PostgreSQL connection or change production writes.
- New imports record `public_qr_v1_sha256` in
  `app.import_runs.checksum_summary`. Existing verified imports can register it
  once with `npm run db:register-public-qr-domain --` plus the explicit source,
  expected source/domain hashes, staging target, and both staging confirmations.
- A previously imported source that contains an intentionally preserved
  unissued/lifecycle inconsistency must also provide the exact QR IDs through
  `--allow-preserved-unissued-lifecycle-ids`. This exception is registration
  only: every blocking anomaly must be that exact lifecycle category, the
  allowlist must equal the mapped anomalous IDs, migration 006 must be current,
  its database constraint must still be present as `NOT VALID`, and full
  source-to-PostgreSQL row parity must pass before provenance metadata changes.
  New imports continue to reject the anomaly without exception.
- This boundary does not by itself authorize stable cutover. Read and write
  selection must still be enabled together so a QR cannot be read from
  PostgreSQL and written only to JSON.

### Personal record controlled PostgreSQL primary read boundary

- H5 and miniapp personal record list/detail routes have an independently
  controlled PostgreSQL primary-read boundary. It is disabled by default.
- Enablement requires `PERSONAL_RECORD_POSTGRES_READ_ENABLED=true`, the audited
  `PERSONAL_RECORD_POSTGRES_READ_DOMAIN_SHA256` for `public_qr_v1`, and one
  selection scope. `PERSONAL_RECORD_POSTGRES_READ_SCOPE=allowlist` requires a
  canonical account-ID-only `PERSONAL_RECORD_POSTGRES_READ_ALLOWLIST`; an
  omitted scope remains allowlist-compatible with existing control files.
  Stable authority must explicitly use
  `PERSONAL_RECORD_POSTGRES_READ_SCOPE=all` and omit the allowlist. Unknown or
  conflicting scope settings fail closed.
- In allowlist scope, requests outside the account list retain the JSON path
  without creating a PostgreSQL pool. The explicit `all` scope includes current
  and future canonical account IDs. Selected requests use PostgreSQL as their
  only DTO source, run in bounded read-only repeatable-read transactions,
  verify import provenance and canonical migrations, and preserve account
  ownership checks.
- Missing or unowned selected details preserve `404 RECORD_NOT_FOUND` without
  revealing ownership. Configuration, provenance, version, connection, and
  identity failures return generic `503 PERSONAL_RECORD_READ_UNAVAILABLE` and
  never fall back to stale JSON.
- The pool is lazy, bounded, drains active reads during shutdown, and closes
  with the HTTP process. Deployment alone cannot enable the boundary.
- Stable QR lifecycle writes must not be enabled for an account cohort until
  the matching personal record primary-read cohort is enabled and validated;
  otherwise PostgreSQL-only records would not appear in the JSON-backed
  personal list or detail routes.

### Stable all-scope prerequisites

The authority states, cutover commit point, and permitted rollback actions are
defined in [PostgreSQL Authority and Rollback Contract](authority-and-rollback-contract.md).

- `scope=all` is a selection boundary, not a replication mechanism. Public QR
  and lifecycle routes can select PostgreSQL directly by the request key even
  when JSON has no matching QR, but the QR and its required references must
  already exist in PostgreSQL.
- Stable all-scope enablement is blocked until QR issuance writes and identity
  creation/binding writes use PostgreSQL as their durable authority. Otherwise
  a QR or account created only in JSON after cutover would be selected for
  PostgreSQL and fail closed instead of silently splitting authority.
- Current-head full-route revalidation, isolated PostgreSQL integration with
  PostgreSQL-only QR/record fixtures, coordinated read/write soak, and one
  unified auto-off/rollback path are required before PM2 saves any all-scope
  setting.

### Stable all-scope isolated integration runner

- `npm run test:postgres:stable-scope` is the root-only production-host runner
  for the disposable all-scope integration database. It never restarts PM2 or
  enables a production runtime boundary.
- The runner creates its fixed `_test` database and root-only environment when
  both are absent. It can also reuse that exact pair only after verifying the
  database owner, empty `app` schema, zero active connections, environment
  target, and file permissions. Partial or inconsistent resources fail closed.
- The integration covers PostgreSQL-only H5 and miniapp identity creation and
  merge, admin QR issuance and protected PNG access, public H5/miniapp reads,
  lifecycle activation, and authenticated personal list/detail reads. The
  protected JSON hash must remain unchanged.
- An exit trap terminates test connections and removes the disposable database
  and environment on success or ordinary failure. A root-only, value-free test
  log remains under `/root/stable-scope-integration-audit-20260812/`.
- The runner is an integration gate only. Passing it does not enable stable
  authority; producer authority, privacy remediation, the authority/rollback
  contract, and coordinated soak remain required.

### Cross-account phone content privacy gate

- New direct records, co-creation records, and co-creation comments reject an
  exact full phone number that belongs to another canonical account. The
  owner's own full phone remains permitted by the recorded policy. H5 and
  miniapp return `400 CONTENT_PRIVACY_REJECTED` without mutating lifecycle or
  comment state.
- The JSON path evaluates the policy against the current identity snapshot.
  The PostgreSQL path performs a parameterized boolean `EXISTS` check inside
  the lifecycle transaction and never returns another account's phone to the
  application.
- `npm run privacy:audit -- --dry-run --input=<absolute-protected-snapshot>
  --expected-source-sha256=<sha256>` performs the historical discovery pass.
  It refuses the live runtime `db.json`, symlinks, relative paths, missing
  hashes, and source changes during execution.
- Audit output contains QR identifiers, counts, and before/after content
  fingerprints only. It never persists raw phone numbers, identity values,
  business content, or the protected snapshot path.
- The report also classifies proof and archive dependencies without exposing
  proof values. An affected record with existing evidence must not be rewritten
  until the remediation preserves the meaning of that immutable evidence.
- This gate prevents recurrence but does not rewrite historical rows. A
  separate exact-target, resumable JSON/PostgreSQL correction must be produced
  only after the protected production snapshot confirms the expected finding
  set and hashes.
- On the production host, `npm run privacy:audit:production-snapshot` wraps the
  generic scanner with the approved protected snapshot, exact three-QR finding
  set, root-only evidence directory, default-off runtime checks, and source
  immutability checks. It does not connect to PostgreSQL or restart PM2.
- Because the three confirmed findings are pre-launch test records with old
  immutable proof dependencies, `npm run privacy:prepare:production-snapshot`
  creates a root-only candidate for the explicit
  `PRELAUNCH_TEST_DATA_REDACT_AND_REPROOF` strategy. The candidate redacts only
  the approved records, detaches their old proof/archive references, preserves
  value-free evidence fingerprints, and must contain zero privacy findings.
  Redaction runs as a bounded fixed-point operation over those exact record IDs:
  each round is re-audited, no new ID or comment scope is permitted, and failure
  to reach `CLEAN` within eight rounds blocks preparation without writing output.
  Preparation never writes the live JSON file, PostgreSQL, OSS, or PM2 state.
- `npm run privacy:apply:preflight:production-snapshot` validates the pinned
  clean candidate, preparation report, exact three-record plan delta, current
  production source/domain marker, all migrations, and full PostgreSQL/source
  parity. The wrapper uses a read-only PostgreSQL session, requires all runtime
  migration boundaries to remain off, and does not change JSON, PostgreSQL,
  OSS, or PM2.
- The underlying apply state machine uses one serializable advisory-locked
  transaction to revise only the
  approved records, remove their superseded proof/archive rows, register the
  candidate source/domain marker, mark the old source as superseded so stale
  runtime configs fail closed, and enqueue one deterministic reproof job per
  record. The JSON replacement is hash-guarded and atomic. Re-running after an
  interruption recognizes the committed side and completes without duplicating
  the import marker or outbox work.
- The controlled reproof state machine preserves proof attempts and outbox
  history as operational evidence instead of forcing those tables to resemble
  the JSON import plan. It synchronizes the final proof and archive fields back
  into JSON, verifies exact `public_qr_v1` parity against PostgreSQL, registers
  a new passed final marker, and supersedes the intermediate candidate marker.
  Explicit record/proof/archive timestamps and the generated proof ID are
  carried in the final JSON so the public domain remains reproducible; legacy
  snapshots without those optional fields retain their existing mapping.
- `npm run privacy:apply:controlled:production-snapshot` is the single guarded
  production entry point. It requires the candidate SHA-256 as an explicit
  confirmation, a root-owned mode-`600` provider environment path, and explicit
  expected AVATA environment and HTTPS API origin values. The provider file
  must set `AVATA_ENV` explicitly; the gate reports only the matched environment
  and origin and never reports credentials. It
  verifies default-off PM2 state, enters one maintenance window, applies the
  exact candidate, processes only `SSS00003`, `SSS00008`, and `SSS00009`, polls
  submitted provider operations to confirmation, and restarts the unchanged
  default-off PM2 process. The command never calls `pm2 save` or imports
  provider/database secrets into the PM2 environment.
- The reproof child process has a system-level hard timeout slightly above its
  bounded polling deadline. A hung provider request is terminated and the
  shell recovery trap restores the default-off PM2 runtime.
- A failed or interrupted run restarts the default-off JSON runtime and leaves
  root-only audit evidence. Re-running the same command classifies the durable
  state as candidate-ready, reproof-in-progress, final-JSON-pending, or already
  complete and resumes without deleting attempts or resubmitting completed
  jobs. External side effects are not described as rollbackable; deterministic
  manifest/operation IDs and durable outbox state provide idempotent recovery.

### Selected clean PostgreSQL baseline route

- The selected pre-launch route does not reproof the three historical test
  records in production. The controlled apply/reproof runner remains available
  for a future requirement to preserve their complete proof history, but it is
  not the current migration action.
- `npm run baseline:plan:clean-postgres` is the root-only, plan-only gate. It
  reads the immutable production snapshot, the exact privacy-clean candidate,
  and its preparation report. It does not connect to PostgreSQL, write the live
  JSON file, access OSS, call the proof provider, or restart PM2.
- The plan retains the redacted `SSS00003`, `SSS00008`, and `SSS00009` records
  without their superseded proof/archive references and excludes only the
  invalid unissued/lifecycle test row `STAR0001`. It then proves the resulting
  103-QR source is import-ready, privacy-clean, and domain-hash reproducible.
- The plan persists only a root-owned, mode-`600`, value-free report containing
  exact scope, collection counts, fingerprints, target hashes, and backup
  requirements. It never persists the generated target source.
- A reviewed plan is followed by a separate guarded rebuild command: take
  immutable JSON and PostgreSQL backups, import the planned source into a clean
  PostgreSQL database, validate parity, and keep the JSON runtime default-off.
  A newly issued PostgreSQL-only QR must pass the complete H5, miniapp,
  lifecycle, and personal-record path before coordinated cutover. The lifecycle
  write must enqueue one untouched pending proof job while the proof worker and
  all provider configuration remain disabled.
- `npm run baseline:rebuild:clean-postgres` materializes only the exact approved
  target hash into a root-owned audit directory, creates the new fixed
  `xingxing_clean_baseline_20260812_staging` candidate database, applies all
  canonical migrations, and imports and verifies the 103-QR/55-record plan.
  It refuses an existing or partial target, never selects or modifies the old
  staging database, and removes only a target database that the same invocation
  created when ordinary failure occurs. The successful candidate remains
  disconnected from PM2 for the PostgreSQL-only new-QR end-to-end gate.
- `npm run test:postgres:clean-candidate-e2e` clones that exact candidate into
  the fixed disposable `_test` database, then creates a future QR and identity
  that exist only in PostgreSQL. It exercises QR image access, H5 and miniapp
  identity merge, lifecycle activation, public and personal reads, and durable
  proof-outbox enqueueing. The proof runtime is explicitly disabled, no AVATA
  fields are supplied, and external fetches are forbidden. The clone,
  environment, and generated image are removed on ordinary success or failure;
  the clean candidate, legacy staging database, JSON source, and PM2 process are
  unchanged.
- The same command is the coordinated joint-rehearsal entry point. Before the
  PostgreSQL-only write, it selects one existing activated record whose account
  has both H5 and miniapp identities and verifies public plus authenticated
  list/detail routes in both channels. After the new QR leaves one pending,
  unclaimed proof job, the existing fixture fingerprint must remain unchanged.
  All five PostgreSQL authority selectors share one child-process `scope=all`
  configuration and close together; PM2 remains default-off throughout. Audit
  output records only gates, counts, and hashes.

### Stable cutover read-only preflight

- `npm run cutover:preflight:stable` is the root-only gate between the
  coordinated joint rehearsal and the maintenance-window cutover. It does not
  restart or save PM2, create business rows, select the legacy staging database
  as the target, or cross the PostgreSQL authority commit point.
- The preflight verifies the exact clean candidate database, canonical
  migrations, source/plan/public-domain hashes, zero outbox backlog, the latest
  successful joint-rehearsal evidence, and the still-default-off production
  runtime. Candidate access uses a read-only session with a bounded statement
  timeout.
- The current JSON authority domain and the clean PostgreSQL candidate domain
  are separate transition invariants. The preflight calculates the JSON
  baseline with the checked-out mapping code, pins it as
  `POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256`, and independently pins the clean
  candidate domain on each PostgreSQL boundary. A route must match the former;
  PostgreSQL provenance and migrations must match the latter. Neither check is
  relaxed when the two domains intentionally differ.
- It creates a root-owned candidate `pg_dump`, validates its `pg_restore --list`
  inventory, snapshots the current JSON authority, and writes a separate
  value-free selector proposal. The proposal enables public read, personal
  read, lifecycle write, identity authority, and QR issuance authority together
  under explicit `scope=all`; static allowlists are forbidden. The proof runtime
  is explicitly `false` and carries no scope or provider configuration.
- AVATA is outside this migration scope and is not a preflight dependency. The
  successful result is `READY_FOR_POSTGRES_MAINTENANCE_WINDOW`; it confirms
  `EXTERNAL_PROVIDER_CALLS=NONE` and does not load the proposal into PM2.
- Passing this preflight permits review and construction of the separate
  maintenance-window runner. It does not authorize an operator to mix old
  cohort files, enable only part of the producer set, or fall back to JSON after
  the first PostgreSQL-only business mutation commits.

### Maintenance-window preparation

- `npm run cutover:prepare:maintenance` is a second root-only, read-only gate.
  It binds the current Git commit and tree to the latest successful stable
  preflight, coordinated joint rehearsal, candidate backup, JSON authority
  snapshot, candidate environment hash, and five-boundary selector proposal.
- The command opens the candidate only with
  `default_transaction_read_only=on`, proves that no transaction ID was
  assigned, verifies that PM2 remains in JSON authority with no database
  connection, and checks that the host can later schedule the bounded
  prewrite auto-off timer.
- Its only new artifacts are a root-owned mode-`600` value-free plan and
  summary. The plan contains paths and SHA-256 evidence but no database or
  provider secret. It does not load PM2 configuration, schedule a timer,
  restart the application, enable the write freeze, or enter
  `POSTGRES_AUTHORITY_PREWRITE`.
- A passing preparation result authorizes implementation and review of the
  separate prewrite/auto-off runner. Entering prewrite and removing the freeze
  remain explicit later operations; neither is exposed through this npm
  preparation command.

### Stable cutover prewrite rehearsal

- The reviewed prewrite runner is intentionally not exposed as an npm shortcut.
  It requires root, the exact protected `prewrite-plan.env`, the explicit
  `--enter-prewrite` mode, and the full confirmation phrase. Updating the code
  invalidates the old plan, so stable preflight and maintenance preparation
  must be rerun after deployment.
- Before PM2 changes, the runner captures value-free normalized fingerprints
  for one public H5 and miniapp QR response. It persists only SHA-256 values,
  strips signed URL query churn, schedules a 15-minute systemd auto-off, and
  only then restarts PM2 with the five `scope=all` PostgreSQL boundaries.
- The protected plan carries both the JSON baseline domain and PostgreSQL
  target domain. The runner recomputes the live JSON baseline before entry,
  verifies the shared baseline selector in the restarted process, and reports
  a failing fingerprint channel/status without persisting its response body.
- `POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true` is mandatory throughout
  prewrite. Reads are compared with the JSON fingerprints while all mutating
  HTTP methods return `503 POSTGRES_CUTOVER_WRITE_FROZEN`. The proof runtime and
  AVATA remain disabled, and the command never calls `pm2 save`.
- The auto-off runner proves the exact candidate state before any JSON fallback.
  If a PostgreSQL business mutation or partial boundary state is detected, it
  refuses fallback and keeps the application frozen. With an unchanged
  candidate, it first disables all PostgreSQL boundaries while retaining the
  freeze, verifies that secrets and connections are gone, and only then removes
  the freeze to restore JSON authority.
- A successful prewrite entry is still before the authority commit point. The
  next operation is a manual auto-off rehearsal; stable enablement requires a
  separate, later command and explicit operator confirmation.
