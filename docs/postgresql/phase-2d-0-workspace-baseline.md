# PostgreSQL Phase 2D-0 Workspace And Shadow-Read Baseline

## 1. Audit Status

- `AUDIT_BASELINE_HEAD=def67d8`
- `CURRENT_IMPLEMENTATION_HEAD=aa613c6`
- `WORKTREE_AUDIT_STATUS=PASS`
- `RUNTIME_PATH_UNCHANGED_BY_POSTGRES_PHASES=YES`
- `MIGRATION_FILESET_STATUS=PASS`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

`PARTIAL` described the original audit provenance, not a detected runtime
integration defect. The Batch 1 and PostgreSQL phases accumulated in one
uncommitted worktree, and most PostgreSQL files were still untracked. Git could
prove the current bytes and the tracked/untracked boundary, but it cannot
independently prove the historical
phase in which every uncommitted line was introduced. Phase attribution below
is reconstructed from file responsibility, phase documentation, tests, and
the current diff. `CONFIRMED` means those sources identify one purpose without
ambiguity; it does not mean a stage-specific Git commit exists.

No file was staged, committed, pushed, or deployed during the original audit.
Section 11 records the later dependency-ordered submission result.

## 2. Worktree Inventory

### 2.1 Tracked Modifications

| File | Phase | Purpose | Runtime effect | Attribution |
|---|---|---|---|---|
| `package.json` | Phase 2A-2 | Add `pg`, migration commands, and infrastructure tests to `npm test` | Adds dependency and manual commands; server start command is unchanged | CONFIRMED |
| `package-lock.json` | Phase 2A-2 | Lock `pg` and transitive packages | Dependency installation only; no automatic connection | CONFIRMED |
| `scripts/recover-from-oss.js` | Batch 1 | Require the DB source hash for recovery writes | Explicit offline recovery behavior; not a request path | CONFIRMED |
| `src/server/services/dbService.js` | Batch 1 | Pure reads, explicit migration, atomic/hash-guarded JSON writes | Yes: intentional JSON runtime hardening, unrelated to PostgreSQL routing | CONFIRMED |
| `tests/api.test.js` | Batch 1 | Cover JSON read/write/migration/conflict behavior | Test only | CONFIRMED |

Tracked diff summary at the audit baseline: five files, 706 insertions and 113
deletions. Git warned about future LF-to-CRLF conversion in four pre-existing
tracked worktree files; `git diff --check` still passes.

### 2.2 Untracked Migration And Documentation Files

| File | Phase | Purpose | Runtime effect | Attribution |
|---|---|---|---|---|
| `database/migrations/001_init_schema.sql` | Phase 2A | Initial PostgreSQL schema | None until the manual runner is invoked | CONFIRMED |
| `database/migrations/002_add_comment_source_position.sql` | Phase 2C-2B-7 | Preserve JSON comment source order | None until the manual runner is invoked | CONFIRMED |
| `docs/postgresql/README.md` | Cross-phase | PostgreSQL migration status index | None | CONFIRMED |
| `docs/postgresql/schema-v1.md` | Phase 1/2A, amended 2C-2B-7 | Target schema contract | None | CONFIRMED |
| `docs/postgresql/importer-spec-v1.md` | Phase 1/2B, amended 2C-2B-7 | Import contract | None | CONFIRMED |
| `docs/postgresql/phase-2a-decisions.md` | Phase 2A | Schema implementation decisions | None | CONFIRMED |
| `docs/postgresql/repository-contracts-v1.md` | Phase 1/2C | Repository contracts | None | CONFIRMED |
| `docs/postgresql/repository-implementation-v1.md` | Phase 2C-1, amended 2C-2B-7 | Implemented repository boundary | None | CONFIRMED |
| `docs/postgresql/service-migration-map-v1.md` | Phase 2C-2A | JSON-to-repository business map | None | CONFIRMED |
| `docs/postgresql/source-inventory-v1.md` | Phase 2B-1, amended 2C-2B-7 | Source field dispositions | None | CONFIRMED |
| `docs/postgresql/public-qr-read-adapter-v1.md` | Phase 2C-2B-1 through 2C-2B-7 | Public QR compatibility evidence and gates | None | CONFIRMED |
| `docs/postgresql/phase-2d-0-workspace-baseline.md` | Phase 2D-0 | This audit baseline | None | CONFIRMED |

### 2.3 Untracked Database And Import Tooling

| File | Phase | Purpose | Runtime effect | Attribution |
|---|---|---|---|---|
| `scripts/database/migrate.js` | Phase 2A-2 | Explicit checksum migration runner | Manual CLI only | CONFIRMED |
| `scripts/database/import-dry-run.js` | Phase 2B-1 | Explicit read-only importer analysis CLI | Manual CLI only | CONFIRMED |
| `scripts/database/import-staging.js` | Phase 2B-2 | Staging-only import coordinator | Manual CLI only | CONFIRMED |
| `scripts/database/importer/index.js` | Phase 2B-1 | Importer composition | Imported only by database scripts/tests | CONFIRMED |
| `scripts/database/importer/reader.js` | Phase 2B-1 | Explicit path/hash source reader | Imported only by database scripts/tests | CONFIRMED |
| `scripts/database/importer/report.js` | Phase 2B-1 | Redacted anomaly report | Imported only by database scripts/tests | CONFIRMED |
| `scripts/database/importer/mapping.js` | Phase 2B-1, amended 2C-2B-7 | Deterministic JSON-to-table plan and source positions | Imported only by database scripts/tests | CONFIRMED |
| `scripts/database/importer/validator.js` | Phase 2B-1, amended 2C-2B-7 | Structural, relation, lifecycle, and position checks | Imported only by database scripts/tests | CONFIRMED |
| `scripts/database/importer/writer.js` | Phase 2B-2, amended 2C-2B-7 | Transaction-context-only staging inserts | Imported only by staging scripts/tests | CONFIRMED |
| `scripts/database/importer/verify-import.js` | Phase 2B-2, amended 2C-2B-7 | Counts, rows, relations, sequences, and positions | Imported only by staging scripts/tests | CONFIRMED |
| `scripts/database/audit-public-qr-gap.js` | Phase 2C-2B-4 | Redacted offline gap audit | Manual CLI only | CONFIRMED |

### 2.4 Untracked PostgreSQL Runtime-Capable Modules

| File | Phase | Purpose | Current business reachability | Attribution |
|---|---|---|---|---|
| `src/server/database/config.js` | Phase 2A-2 | Explicit PostgreSQL config parsing | Not imported by server startup/routes/services | CONFIRMED |
| `src/server/database/connection.js` | Phase 2A-2 | Explicit pool factory | Not imported by server startup/routes/services | CONFIRMED |
| `src/server/database/healthCheck.js` | Phase 2A-2 | Safe connectivity check | Not mounted in runtime routes | CONFIRMED |
| `src/server/database/transaction.js` | Phase 2A-2 | TransactionContext boundary | Not imported by current business services | CONFIRMED |
| `src/server/repositories/accountRepository.js` | Phase 2C-1 | Account access contract | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/auditRepository.js` | Phase 2C-1 | Audit append contract | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/identityRepository.js` | Phase 2C-1 | Login identity access contract | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/qrRepository.js` | Phase 2C-1 | QR access contract | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/recordRepository.js` | Phase 2C-1 | Record access contract | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/coCreationRepository.js` | Phase 2C-1, amended 2C-2B-7 | Co-creation/comment access and source order | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/orderRepository.js` | Phase 2C-1 | Order access contract | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/paymentRepository.js` | Phase 2C-1 | Payment access contract | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/proofRepository.js` | Phase 2C-1 | Proof access contract | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/qrBatchRepository.js` | Phase 2C-2B-2 | Minimal public batch projection | Unreachable from current routes/services | CONFIRMED |
| `src/server/repositories/errors.js` | Phase 2C-1 | Stable repository error mapping | Unreachable except through repositories | CONFIRMED |
| `src/server/repositories/query.js` | Phase 2C-1 | Parameterized query helpers | Unreachable except through repositories | CONFIRMED |
| `src/server/repositories/mappers.js` | Phase 2C-1, amended 2C-2B-2/7 | Explicit domain row projections | Unreachable except through repositories | CONFIRMED |
| `src/server/repositories/index.js` | Phase 2C-1/2C-2B-2 | Repository exports | Not imported by current runtime entry | CONFIRMED |
| `src/server/services/postgres/publicQrReadAdapter.js` | Phase 2C-2B-1, amended 2C-2B-2/7 | PostgreSQL candidate public DTO | Not imported by routes or existing services | CONFIRMED |
| `src/server/services/postgres/publicQrDtoComparator.js` | Phase 2C-2B-1 | Value-free DTO difference classifier | Not imported by routes or existing services | CONFIRMED |

These modules are capable of connecting or querying only when explicitly
constructed. `src/server/server.js` still imports only `createApp()`, and
`src/server/app.js`, routes, middleware, and existing business services do not
import the PostgreSQL connection, repositories, adapter, or comparator. There
is no `DATABASE_DRIVER`, Shadow Read, JSON/PostgreSQL dual read, or dual write.

### 2.5 Untracked Tests

| File | Phase | Purpose | Runtime effect | Attribution |
|---|---|---|---|---|
| `tests/database-infrastructure.test.js` | Phase 2A-2 through 2C-2B-7 | Config, migration, importer, repository, and source-position tests | Test only | CONFIRMED |
| `tests/postgresql-read-adapter.test.js` | Phase 2C-2B-1 through 2C-2B-7 | Candidate Adapter and comparator contracts | Test only | CONFIRMED |
| `tests/postgresql-read-adapter.integration.test.js` | Phase 2C-2B-2/7 | Manual disposable PostgreSQL DTO validation | Manual test only; not in `npm test` | CONFIRMED |
| `tests/public-qr-gap-audit.test.js` | Phase 2C-2B-4 | Offline audit privacy and aggregation | Test only | CONFIRMED |

## 3. Runtime Boundary Findings

### 3.1 Current JSON Runtime

The running paths remain:

```text
src/server/server.js
  -> createApp()
  -> H5 /api/qr routes or /api/miniapp routes
  -> dbService.findQRByKey()
  -> JSON readDB()
  -> existing route presenter
  -> response
```

The PostgreSQL phases did not modify tracked route, middleware, `app.js`, or
frontend files. The existing JSON presenters and permission/visibility rules
remain active. Batch 1 did intentionally modify `dbService.js` runtime storage
mechanics; that is a separate reviewed JSON safety change and must receive its
own submission boundary.

The PostgreSQL Candidate Adapter's H5 unactivated `false` contract is not a
production API mutation because the Adapter is unreachable from the running
application. It is the approved candidate behavior to match the current
production dataset and frozen compatibility contract.

### 3.2 Public DTO Safety

The candidate strips `source_position`, account IDs, owner account IDs,
PostgreSQL co-creation/proof UUIDs, phone snapshots, and OpenIDs. It retains
existing public/business fields such as QR ID, batch ID, image object key, and
legacy public comment ID because those are already part of the JSON DTO.

## 4. Migration Baseline

| Order | File | SHA-256 | Status |
|---|---|---|---|
| 1 | `001_init_schema.sql` | `c827cd85e9552805690d6837383fb6d23c043d32be359ce61b99f743ba477d18` | Matches the previously recorded baseline |
| 2 | `002_add_comment_source_position.sql` | `7505f4d030aaf6f354ecb5d53ae98729c7f0ebe90c28f3c8347180470c4f0ad4` | Additive source-position migration |

- `MIGRATION_FILESET_COUNT=2`
- `CURRENT_DATABASE_PENDING=NOT_QUERIED`
- `LAST_DISPOSABLE_PG_VERSION=15.18`
- `LAST_DISPOSABLE_PG_POST_APPLY_PENDING=0`
- `LAST_DISPOSABLE_PG_VALIDATION=PASSED`

The last three values are inherited Phase 2C-2B-7 evidence, not statements
about production or any currently connected database. Phase 2D-0 made no
database connection.

## 5. Frozen Public QR Compatibility Contract

### Gap 1: Disclosure

- H5 unactivated DTO includes `show_brand_disclosure=false`.
- Miniapp unactivated DTO omits `show_brand_disclosure`.
- An unactivated response is not a persisted user choice.
- Direct save/co-creation start stores the submitted boolean and disclosure
  text snapshot in record semantics.
- `co_creating` and `activated` candidate reads use `records`.

### Gap 2: Comment Order

- `source_position` is the zero-based original JSON array index within each
  co-creation.
- Effective and deleted comments retain positions; deletion never renumbers.
- `(co_creation_id, source_position)` is unique.
- Repository output carries the internal position in deterministic source
  order.
- Public output excludes deleted comments and sorts by
  `created_at DESC, source_position ASC`.
- `source_position` is never serialized into the public DTO.

## 6. Shadow Read Insertion Design

### 6.1 Real Baseline Paths

H5:

```text
global attachUserSession()
  -> GET /api/qr/:qrId
  -> findQRByKey()
  -> hidden/not-found checks
  -> formatQRStatusPayload(qr, req)
  -> res.json({ status, code, data })
```

Miniapp:

```text
GET /api/miniapp/qr/:key
  -> optionalMiniappAuth
  -> findQRByKey()
  -> hidden/not-found checks
  -> formatQRPayload(qr, req.miniappUser)
  -> res.json({ status, code, data })
```

The recommended future observer hook is after the existing presenter has
produced the final `data` DTO and before `res.json` is called. The route should
send the baseline response without awaiting Candidate work. The observer must
receive a defensive DTO copy, normalized key, channel, and server-derived
viewer context only. It must never accept account, owner, phone-bound, or
identity data from query/body input.

The first rollout should compare successful 200 DTOs only. Not-found and
hidden outcomes require a separately designed outcome-envelope comparator;
they must not be forced through the DTO comparator or silently reclassified.

### 6.2 Baseline, Candidate, And Comparator

- Baseline: the final existing JSON `data` DTO after visibility, optional-auth,
  URL resolution, and channel-specific field omission.
- Candidate: `PublicQrReadAdapter` using a read-only PostgreSQL transaction and
  server-derived viewer context.
- Comparator: `comparePublicQrDtos()` over the two `data` values.
- Baseline always determines HTTP status, headers, and response body.
- Candidate timeout, query failure, resolver failure, or mismatch is internal
  evidence only and must not reach the user or change authentication behavior.

The comparator already records path, kind, value types, array counts, channel,
total count, and truncation without recording compared values. A future sink
may additionally record lifecycle, observer version, and a correlation token
that cannot be reversed to QR key or account identity. It must not store QR
keys, content, comment text, URLs, phone/OpenID/account IDs, addresses, tokens,
or provider payloads.

### 6.3 Resolver And Transaction Gate

The JSON presenters and candidate do not yet share one production resolver:

- H5 prefers a signed URL for object-key records and may fall back to the URL
  snapshot.
- Miniapp prefers its current URL, then public object URL, then signed URL.
- Candidate requires an injected channel-aware resolver.

The offline fixture comparison proves stable resolver output only. Before
execution, define a production resolver contract and prove that its output is
equivalent without logging URLs. If resolution can perform network I/O, it
must run outside the PostgreSQL transaction and database lock lifetime. The
current Adapter performs resolution before `read()` returns, so transaction
ownership and resolver purity must be settled in Shadow Read design rather
than assumed.

## 7. Read Performance Baseline

Current JSON behavior:

- `findQRByKey()` scans the in-memory parsed `qr_codes` array. Token hits read
  and scan once; ID fallback can read and scan twice.
- Batch projection calls `listBatches()`, causing another complete JSON read
  and batch scan when a batch ID exists.
- Record, co-creation, comments, proof, and archive data are embedded on the QR
  aggregate, so there is no per-comment database query.

Candidate PostgreSQL behavior:

- unactivated with batch: two indexed queries;
- bound co-creating: up to five fixed queries;
- activated with co-creation/proof: up to six fixed queries;
- QR token/ID, batch, record, co-creation, kept-comment source order, and proof
  have dedicated keys/indexes;
- no query is issued per comment, so the current read has no N+1 pattern;
- the repository currently fetches all effective comments without a SQL limit.

The business write path limits effective comments to 12, but a corrupted or
manually altered PostgreSQL dataset could exceed that number. Shadow Read
design must decide whether to fetch at most 13 and treat overflow as a
candidate integrity failure. Phase 2D-0 does not optimize or change queries.

## 8. Shadow Read Gates

Design prerequisites currently satisfied:

- DTO contract is frozen.
- Candidate Adapter coverage is complete for the approved public DTO.
- Comparator is value-free and bounded.
- baseline-wins and candidate-failure behavior are defined.
- mismatch categories and forbidden log data are defined.

Execution remains blocked until all of the following are reviewed:

1. Cumulative Batch 1 and PostgreSQL work receives explicit submission
   boundaries; current stage attribution is not Git-proven.
2. Production-safe PostgreSQL configuration and final backup import rehearsal
   are separately approved.
3. Resolver equivalence and transaction lifetime are proven.
4. Sampling, candidate timeout, concurrency budget, and circuit breaker are
   approved.
5. Mismatch sink access, retention, aggregation, and deletion policy are
   approved.
6. Success/error outcome coverage and abort thresholds are frozen.
7. Rollback means disabling the observer only; baseline JSON behavior must
   remain untouched.

Therefore:

- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

## 9. Validation Evidence

Phase 2D-0 does not rerun tests because it modifies documentation only.
Inherited evidence is recorded, not represented as a new run:

- prior `npm test`: 131/131 passed;
- prior manual disposable PostgreSQL integration: 1/1 passed;
- prior JSON/PostgreSQL public DTO comparison: mismatch count zero;
- current `git diff --check`: passed with existing line-ending warnings only.

JSON remains the sole runtime data source. This audit does not authorize a
feature flag, observer, PostgreSQL request traffic, dual read, dual write, or
deployment.

## 10. Phase 2D-0.5 Commit Boundary Readiness

### 10.1 Baseline And Status

- `HEAD=def67d8`
- `TRACKED_MODIFIED_COUNT=5`
- `UNTRACKED_COUNT=47`
- `TOTAL_UNCOMMITTED_PATHS=52`
- `STAGED_PATHS=0`
- `CLASSIFICATION_STATUS=COMPLETE`
- `COMMIT_BOUNDARY_PLAN_STATUS=READY`
- `RUNTIME_PATH_STATUS=UNCHANGED`
- `WORKTREE_AUDIT_STATUS=PARTIAL`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

`WORKTREE_AUDIT_STATUS` remains `PARTIAL`: this phase can define a safe future
commit sequence, but it cannot make historical provenance Git-verifiable while
all accumulated changes remain uncommitted. No unclassified runtime path was
found, and no staged content exists.

An independent commit means that the proposed commit can be checked out on top
of its stated parent, contains every file it imports at runtime or test load
time, and can run the tests that exist at that point in the sequence. It may
depend on earlier commits in the declared sequence; it must not depend on a
later commit or an uncommitted file.

### 10.2 Cross-Phase And Hunk-Level Findings

| File | Finding | Boundary decision |
|---|---|---|
| `tests/api.test.js` | All added tests cover Batch 1 JSON migration, read, write, conflict, recovery, and QR-generation behavior | Commit with Batch 1 as a whole file |
| `package.json` | One diff combines the `pg` dependency and migration commands with adding the not-yet-committed infrastructure test to `npm test` | Split by hunk: dependency/DB commands in Group B; test-command expansion in Group D |
| `package-lock.json` | The lockfile change supplies `pg@8.22.0` and its transitive dependencies | Commit with the Group B dependency hunk |
| `tests/database-infrastructure.test.js` | Top-level imports span connection, migration, importer, staging writer, and every repository; a partial file would be fragile | Commit the complete file only after Groups B and C and with Group D repositories |
| `scripts/database/importer/mapping.js`, `validator.js`, `writer.js`, `verify-import.js` | Their final forms already include `source_position`; separating the historical amendment would create an importer that does not match the current migration plan | Commit their final forms with Migration `002` in Group C |
| `src/server/repositories/coCreationRepository.js`, `mappers.js` | Their final projections depend on the Group C `source_position` schema/import contract | Commit final forms in Group D after Group C |
| `docs/postgresql/README.md`, `public-qr-read-adapter-v1.md` | These documents describe several completed phases and cannot honestly accompany only one early code group without hunk reconstruction | Commit with the consolidated documentation group after implementation groups |

No current untracked file needs to be rewritten to form these boundaries. The
future submission phase must use patch/hunk staging for `package.json`; staging
that file wholesale in Group B would make the commit depend on the Group D test
file and is therefore `NOT_INDEPENDENT_COMMIT`.

### 10.3 Proposed Commit Sequence

#### Group A: Batch 1 JSON Consistency

Files:

- `src/server/services/dbService.js`
- `scripts/recover-from-oss.js`
- `tests/api.test.js`

Purpose: production JSON read/write, explicit migration, recovery hash, and
conflict protection. This is the only group that intentionally changes the
current runtime data source behavior. It has no PostgreSQL dependency.

- Parent: `def67d8`
- Required verification: `npm test`, `git diff --check`
- Rollback boundary: revert Group A only
- `INDEPENDENT_COMMIT_STATUS=READY`

#### Group B: PostgreSQL Schema And Connection Foundation

Files/hunks:

- `package.json`: only `pg`, `db:migrate:dry`, and `db:migrate` hunks
- `package-lock.json`
- `database/migrations/001_init_schema.sql`
- `src/server/database/config.js`
- `src/server/database/connection.js`
- `src/server/database/healthCheck.js`
- `src/server/database/transaction.js`
- `scripts/database/migrate.js`

Purpose: install the driver and add explicit, manually invoked PostgreSQL
connection/migration infrastructure. The `npm test` command must still name
only `tests/api.test.js` in this commit.

- Parent: Group A
- Required verification: JS syntax checks, existing `npm test`, migration
  dry-run target validation, `git diff --check`
- Rollback boundary: removes all PostgreSQL connection/migration capability
- Current whole-file status: `NOT_INDEPENDENT_COMMIT`
- Status after the required `package.json` hunk split: `READY`

#### Group C: Importer, Staging Writer, And Source-Position Migration

Files:

- `database/migrations/002_add_comment_source_position.sql`
- `scripts/database/import-dry-run.js`
- `scripts/database/import-staging.js`
- `scripts/database/importer/index.js`
- `scripts/database/importer/mapping.js`
- `scripts/database/importer/reader.js`
- `scripts/database/importer/report.js`
- `scripts/database/importer/validator.js`
- `scripts/database/importer/writer.js`
- `scripts/database/importer/verify-import.js`

Purpose: deterministic dry-run planning, staging-only writes, verification,
and preservation of the original JSON comment array position. Migration `002`
depends on Group B's `001`; staging imports depend on Group B connection and
migration modules.

- Parent: Group B after its hunk split
- Required verification: JS syntax checks, importer fixture dry-run, existing
  `npm test`, `git diff --check`
- Rollback boundary: removes importer/staging tools and additive Migration 002
- `INDEPENDENT_COMMIT_STATUS=READY`

#### Group D: Repository Foundation And Infrastructure Test Registration

Files/hunks:

- every file under `src/server/repositories/`
- `tests/database-infrastructure.test.js`
- `package.json`: only expand `npm test` to include the infrastructure test

Purpose: add transaction-context repositories and register the single test
file that loads and verifies Groups B, C, and D. Committing the test earlier
would fail during module loading because its top-level imports include importer,
staging, and repository modules.

- Parent: Group C
- Required verification: `npm test`, repository syntax checks,
  `git diff --check`
- Rollback boundary: removes repositories and their registered tests while
  retaining explicit PostgreSQL migration/import tools
- `INDEPENDENT_COMMIT_STATUS=READY`

#### Group E: Public QR Candidate, Comparator, Audit, And Offline Tests

Files:

- `src/server/services/postgres/publicQrReadAdapter.js`
- `src/server/services/postgres/publicQrDtoComparator.js`
- `scripts/database/audit-public-qr-gap.js`
- `tests/postgresql-read-adapter.test.js`
- `tests/postgresql-read-adapter.integration.test.js`
- `tests/public-qr-gap-audit.test.js`

Purpose: add the unreachable Public QR PostgreSQL Candidate, value-free DTO
comparison, privacy-preserving history audit, unit tests, and manual disposable
PostgreSQL integration test. None is imported by the running server.

- Parent: Group D
- Required verification: `npm test`, explicit adapter/audit unit tests, manual
  disposable PostgreSQL integration, `git diff --check`
- Rollback boundary: removes all Public QR Candidate evidence without changing
  the JSON runtime
- `INDEPENDENT_COMMIT_STATUS=READY`

#### Group F: PostgreSQL Design, Evidence, And Audit Documentation

Files:

- every file under `docs/postgresql/`

Purpose: document the final code state, inherited test evidence, compatibility
contract, migration map, audit limitations, and Shadow Read gates. The docs
must be checked against Groups A-E immediately before staging so they do not
claim code that is absent from their parent.

- Parent: Group E
- Required verification: link/path review and `git diff --check`
- Rollback boundary: documentation only
- `INDEPENDENT_COMMIT_STATUS=READY`

### 10.4 Dependency Graph And Submission Gates

```text
Group A (JSON safety)
  -> Group B (schema/connection/migration)
  -> Group C (importer/staging/002)
  -> Group D (repositories/infrastructure test registration)
  -> Group E (Public QR candidate/offline validation)
  -> Group F (consolidated docs)
```

Group A is logically independent of Groups B-F but should be submitted first
because it is the only existing-runtime change. Each future commit review must
inspect its cached diff, perform a temporary checkout/worktree test against the
declared parent, and prove that no import resolves only through a later or
unstaged file. A group failing any check must be reported as
`NOT_INDEPENDENT_COMMIT` and merged with its dependency or reordered; code or
tests must not be weakened to force independence.

Current blockers before Shadow Read design implementation:

1. Group B still requires a deliberate `package.json` hunk split.
2. Groups A-F have not been staged, independently checked out, tested, or
   committed in the proposed sequence.
3. Existing execution gates from Section 8 remain: production resolver
   equivalence, transaction lifetime, sampling/timeouts/circuit breaker,
   mismatch retention, and final backup/import rehearsal.

There are no `UNKNOWN` file owners and no detected PostgreSQL runtime imports.
The next permissible phase is a focused Phase 2D-0.6 submission-boundary
review and intentional commit sequence. This document does not authorize
Shadow Read implementation.

## 11. Phase 2D-0.6 Submission Result

The accumulated implementation was committed in the reviewed order:

| Group | Commit | Result |
|---|---|---|
| A | `33e4eac` | JSON consistency committed |
| B | `ddb44e0` | PostgreSQL foundation committed |
| C | `2978cd4` | Importer and staging committed |
| D | `5adca2c` | Repository foundation committed |
| E | `aa613c6` | Public QR Candidate committed |

Group E commit tree
`33e7e9999d883b68a6e0d8d176a3640929ccaf2a` matches its
independently validated candidate tree. The exact tree passed 154/154 offline
tests. A disposable PostgreSQL 15.18 instance then passed the manual Public QR
integration test 1/1, including Migration 001/002, staging import, repository
queries, and JSON/PostgreSQL DTO comparison with mismatch count zero. Cleanup
completed with no Group E PostgreSQL process, data directory, or log remaining.

Final submission state:

- `CLASSIFICATION_STATUS=COMPLETE`
- `COMMIT_BOUNDARY_PLAN_STATUS=COMPLETE`
- `COMMIT_BOUNDARY_EXECUTION=COMPLETE`
- `WORKTREE_AUDIT_STATUS=PASS`
- `RUNTIME_PATH_STATUS=UNCHANGED`
- `ADAPTER_COVERAGE=COMPLETE`
- `OFFLINE_PG_VALIDATION=PASSED`
- `PUBLIC_QR_INTEGRATION_STATUS=PASSED`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

The historical evidence status remains
`AUDIT_INPUT_INTEGRITY=PARTIAL`,
`AUDIT_EVIDENCE_CONFIDENCE=PARTIAL`, and
`AUDIT_COPY_CLEANUP=PENDING`. The commit sequence does not supply new
server-side audit evidence.

JSON remains the only runtime business-data source. No existing route,
middleware, presenter, or business service imports the PostgreSQL Candidate.
No Shadow Read, PostgreSQL request traffic, dual read, dual write, production
database connection, push, or deployment is authorized by this result.
