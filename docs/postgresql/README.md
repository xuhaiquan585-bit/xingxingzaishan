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
- This service is not connected to routes, application startup, PM2 runtime
  configuration, or production traffic. JSON remains the only runtime write
  source, and this boundary does not authorize dual writes or cutover.
- Unit validation and real PostgreSQL identity-write integration are complete.
  The disposable database exercised concurrent identity creation, binding,
  guarded merge, sequence allocation, and reference protection, then was
  removed without changing the staging database.

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
- The guarded runtime assembly requires an exact enable value, an explicit QR
  allowlist, the exact imported source SHA-256, a stable worker ID, complete
  real-provider credentials, and an HTTPS callback URL. Missing or malformed
  settings leave it disabled.
- Worker claims and stale-lock recovery are scoped in SQL to the record-proof
  job type and the same QR allowlist. Provider callback and query results are
  checked against that allowlist again after locking the proof row.
- Every worker pass and provider-result application requires the configured
  source hash to have a passed import and the database to have the exact
  canonical migration set.
- The runtime scheduler is serial, bounded, and closes its timer, active run,
  and pool deterministically. It is not imported by application startup or the
  existing AVATA callback route, so deployment alone cannot start it.
- Interrupted attempts are closed before idempotent resubmission. Existing
  submitted or confirmed proofs do not submit twice, and imported legacy proof
  evidence fails closed instead of being overwritten.
- The worker and proof handler are not connected to PM2, application startup,
  OSS, AVATA, or production traffic. JSON remains the runtime authority until
  the complete per-QR read/write/proof slice passes controlled validation.

### Public QR controlled PostgreSQL primary read boundary

- H5 `GET /api/qr/:qrId` and miniapp `GET /api/miniapp/qr/:key` now have a
  separately controlled PostgreSQL primary-read boundary. It is independent
  from Public QR Shadow Read and is disabled by default.
- Enablement requires all three exact settings:
  `PUBLIC_QR_POSTGRES_READ_ENABLED=true`, a canonical QR-ID-only
  `PUBLIC_QR_POSTGRES_READ_ALLOWLIST`, and the audited 64-character lowercase
  `PUBLIC_QR_POSTGRES_READ_SOURCE_SHA256`.
- JSON resolves only the canonical QR ID and captures the source SHA-256 used
  by the selection gate. Requests outside the allowlist retain the existing
  JSON path and do not construct a PostgreSQL pool.
- An allowlisted request uses PostgreSQL as its only DTO source. Before reading
  business rows, the runtime requires the configured source hash to have a
  passed import and requires the exact canonical migration set. Source drift,
  stale imports, version drift, connection failures, and resolved-ID drift
  return a generic `503 PUBLIC_QR_READ_UNAVAILABLE`; they never fall back to
  JSON. Existing `QR_NOT_FOUND` and `QR_HIDDEN` contracts remain `404` and
  `403`.
- Reads run in bounded read-only repeatable-read transactions. Asset URL
  presentation happens after the transaction is released, and the lazily
  created pool closes with the HTTP process lifecycle.
- This boundary is implementation-only. Deployment does not enable it and
  does not authorize production PostgreSQL traffic. A disposable PostgreSQL
  integration run and a timed, single-QR controlled production read are still
  required before any enablement.
