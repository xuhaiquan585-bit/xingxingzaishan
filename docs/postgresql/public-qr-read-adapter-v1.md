# PostgreSQL Public QR Read Adapter v1

## 1. Phase Boundary And Status

Phase 2C-2B-1 built an isolated PostgreSQL-shaped implementation of the
public QR read behavior. Phase 2C-2B-2 added the minimum public batch
repository and executed an offline comparison against PostgreSQL 15.18.
Phase 2C-2B-3 records decisions for the two remaining compatibility gaps.
Phase 2C-2B-4 added a structural audit tool, and Phase 2C-2B-5 records
separately reported server-side aggregate evidence with conservative
provenance status.
Phase 2C-2B-7 implemented the approved disclosure and stable comment-order
contracts, then repeated disposable PostgreSQL and offline DTO validation.
These phases do not change the runtime request path.

Status is reported on separate axes:

- Work status: implementation work completed or partial.
- Adapter coverage: compatible, partial, or blocked.
- Runtime readiness: not ready until later integration gates pass.

For this implementation:

- JSON `dbService` remains the only runtime business-data source.
- No route imports or calls the adapter.
- No production shadow read, feature flag, dual read, or dual write exists.
- The adapter does not connect to PostgreSQL or read environment variables.
- Existing JSON behavior is the compatibility baseline, even where a future
  product decision may prefer different behavior.

Current phase result:

- `WORK_STATUS=COMPLETED`
- `ADAPTER_COVERAGE=COMPLETE`
- `OFFLINE_PG_VALIDATION=PASSED`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

The two compatibility gaps are closed in the Candidate implementation. Runtime
integration remains not ready because Shadow Read execution controls and
production resolver behavior are separate gates.

## 2. Current Public Read Chains

### 2.1 H5

| Item | Current behavior |
|---|---|
| Route | `GET /api/qr/:qrId` |
| Authentication | Public route; global optional H5 session may provide `req.user` |
| Lookup | `findQRByKey()` checks token and then QR ID |
| Presenter | `formatQRStatusPayload()` in `routes/qr.js` |
| Not found | HTTP 404, `QR_NOT_FOUND` |
| Hidden | HTTP 403, `QR_HIDDEN` |
| Unauthenticated read | Allowed |

### 2.2 Miniapp

| Item | Current behavior |
|---|---|
| Route | `GET /api/miniapp/qr/:key` |
| Authentication | `optionalMiniappAuth`; missing or invalid token does not block the public read |
| Lookup | `findQRByKey()` |
| Presenter | `formatQRPayload()` in `routes/miniapp.js` |
| Not found | HTTP 404, `QR_NOT_FOUND` |
| Hidden | HTTP 403, `QR_HIDDEN` |
| Unauthenticated read | Allowed |

The adapter accepts a normalized key. Route parameter decoding and optional
authentication remain route concerns and are not reimplemented.

## 3. Current JSON Sources

The public payload currently reads:

| Payload area | JSON source |
|---|---|
| QR identity, lifecycle, visibility, issue state | `qr_codes` top-level fields |
| Saved record content, image, timestamps, disclosure snapshot | fields embedded in the same `qr_codes` object |
| Co-creation owner and state | fields embedded in the same `qr_codes` object |
| Co-creation comments | embedded comment array |
| Proof status and certificate metadata | chain/proof fields embedded in the QR object |
| Batch brand disclosure | `batches`, with counts currently computed by scanning `qr_codes` |
| Storage mode | runtime storage configuration |
| Signed image/certificate URL | storage service resolution |

PostgreSQL normalizes these sources into `qr_codes`, `records`,
`co_creations`, `co_creation_comments`, `record_proofs`, and `qr_batches`.

## 4. Existing Behavior Freeze

This phase does not improve or reinterpret the JSON behavior. In particular it
must preserve:

- public access and current 404/403 semantics;
- H5 and miniapp field differences;
- lifecycle-dependent field omission;
- the co-creation phone-binding visibility gate;
- effective-comment filtering and newest-first ordering;
- owner and participant markers based on authenticated `account_id`;
- `null`, empty string, and absent-field behavior;
- current chain status text and confirmed-only transaction/certificate fields;
- current public disclosure fields.

It must not change comment visibility, owner rules, lifecycle rules, response
shape, or error codes. Any later behavior improvement requires a separate
product and API change.

## 5. Visibility And DTO Compatibility Matrix

### 5.1 Common Base Fields

Both channels return:

- `id`
- `qr_id`
- `activation_status`
- `issue_status`
- `active_storage_mode`
- `batch_id`

When a batch exists, both also return:

- `batch_brand_name`
- `batch_brand_disclosure_text`
- `batch_brand_disclosure_default`

Miniapp additionally returns `phone_bound`.

### 5.2 Lifecycle Fields

| Lifecycle and viewer | H5 | Miniapp |
|---|---|---|
| `unactivated` | base plus source `show_brand_disclosure` boolean | base |
| `co_creating`, no bound phone | base only | base only, including `phone_bound: false` |
| `co_creating`, bound phone | record, image, co-creation comments/markers, disclosure | same plus `brand_name` |
| `activated` | record, image, proof, co-creation comments/markers, disclosure | same plus `brand_name` |

The public DTO must never add `record.account_id`,
`co_creation_owner_account_id`, `comment.account_id`, identity credentials, or
database-only primary keys.

### 5.3 Comment Rules

- Deleted comments are excluded.
- Effective comments are sorted by `created_at` descending.
- Equal timestamps preserve their source order in the current JSON behavior.
- Public comment IDs use the legacy comment ID when available.
- The participant marker is computed from effective internal rows before
  account IDs are stripped from the public DTO.
- The public comment count equals the visible comment array length.

The existing repository query orders comments by `created_at ASC, id ASC`.
The adapter reverses by timestamp, but UUID ordering cannot prove preservation
of historical source order for equal timestamps. This is a compatibility gap
that must be settled before runtime shadow comparison.

## 6. Adapter Contract

`PublicQrReadAdapter` is constructed with injected dependencies:

- `QrRepository`
- `RecordRepository`
- `CoCreationRepository`
- `ProofRepository`
- `QrBatchRepository`
- an application-owned asset resolver
- non-secret public runtime metadata such as storage mode

The adapter:

- orchestrates reads;
- enforces lifecycle-specific projection;
- maps repository domain records to the existing public DTO;
- returns stable application error codes;
- never returns raw repository rows.

The adapter does not:

- import `dbService`;
- import `pg`, a pool, a client, or the connection layer;
- execute SQL;
- read JSON files or environment variables;
- begin, commit, or roll back transactions;
- write data;
- make route or authorization decisions.

Future integration must create all repositories from the same caller-owned,
read-only transaction context when snapshot consistency is required. The
adapter itself does not own transaction control.

## 7. Repository Coverage

| Need | Existing capability | Status |
|---|---|---|
| QR key/token/ID lookup | `QrRepository.findByKey()` | Available |
| Record by QR | `RecordRepository.findByQrId()` | Available |
| Co-creation by QR | `CoCreationRepository.findByQrId()` | Available |
| Effective comments | `CoCreationRepository.listEffectiveComments()` | Available with ordering caveat |
| Proof by record | `ProofRepository.findByRecordId()` | Available |
| Batch disclosure by batch ID | `QrBatchRepository.findById()` | Available |
| Unactivated legacy disclosure flag | Not present in normalized `qr_codes` | Data-model gap |

The proof adapter uses the actual schema relationship:
`record_proofs.record_qr_id -> records.qr_id`.

The asset resolver and public storage mode are application dependencies, not
repository responsibilities. A missing object-key resolver fails closed rather
than returning an invalid URL.

The current H5 JSON presenter exposes `show_brand_disclosure` even for an
unactivated QR. The normalized schema stores that field on `records`, and an
unactivated QR has no record. The adapter preserves the field if a supplied QR
projection contains it, but the current `QrRepository` cannot supply it. A
later review must either prove the legacy value is always false, add a
deliberate compatibility projection, or approve an API normalization. This
phase does not guess.

No `PublicQrRepository`, `getEverything()`, generic CRUD repository, or direct
SQL shortcut is introduced.

The remaining compatibility gaps are explicit:

| Gap | Evidence | Resolution boundary |
|---|---|---|
| `PUBLIC_DTO_GAP_UNACTIVATED_DISCLOSURE` | The JSON H5 presenter emits a false QR initialization value before a record exists, while PostgreSQL correctly stores the submitted user choice on `records` | Preserve the H5 unactivated field shape with an explicit false compatibility projection; do not treat it as a persisted choice or add a QR-level database field |
| `DATA_MODEL_GAP_COMMENT_SOURCE_ORDER` | Equal JSON comment timestamps preserve embedded array order, but the normalized schema has no source-position column | Add and import a stable source-order value, or approve a documented ordering change |

Neither gap is hidden with `null`, a hardcoded value, UUID ordering, phone
fallback, or direct JSON access.

## 8. Static Read Performance Baseline

### 8.1 Current JSON Path

For one public read:

- `findQRByKey()` can read and scan `qr_codes` for token lookup and then read
  and scan again for ID lookup.
- Batch enrichment calls `listBatches()`, which scans all QR rows for each
  batch before selecting one batch. Its shape is approximately `O(B * Q)`.
- Comment projection filters and sorts the embedded comment array,
  approximately `O(C log C)`.
- Image and certificate resolution can each add an object-storage operation.

This phase records the baseline and does not optimize JSON behavior.

### 8.2 Future PostgreSQL Path

Expected bounded reads:

- one indexed QR key lookup;
- zero or one indexed batch lookup;
- no record/co-creation/proof reads for `unactivated`;
- no record/co-creation/proof reads for an unbound `co_creating` viewer;
- for a full view: one record lookup, one co-creation lookup, one comment
  query when co-creation exists, and one proof lookup for `activated`.

Relevant schema indexes and constraints include:

- QR primary key and unique access token;
- one record per QR;
- one co-creation per QR;
- comment index by co-creation and creation time;
- proof uniqueness according to the actual record/provider schema;
- batch primary key.

Runtime integration must verify query plans and place a bounded comment limit or
pagination policy before unbounded comment growth becomes possible. It must
avoid per-comment or per-proof N+1 queries.

### 8.3 PostgreSQL 15.18 Offline Result

The manual integration test used an artificial JSON fixture, the existing
importer, a disposable PostgreSQL 15.18 database, real repository SQL, the
adapter, and the redacted comparator.

Supported DTO cases had zero mismatches:

- H5 and miniapp `unactivated`;
- bound and unbound `co_creating`;
- H5 `activated` with proof;
- batch enrichment and effective comments.

The two model gaps produced only their expected redacted paths. Stable fixture
URLs were compared exactly. Object-key resolution remains covered with a
deterministic focused test; a real external OSS signed-URL check is still an
external dependency gate and is not replaced with an empty string.

Observed query counts were bounded:

- `unactivated`: 2;
- unbound `co_creating`: 2;
- bound `co_creating`: 5;
- direct `activated`: 5.

`EXPLAIN` used the batch primary-key index and the effective-comment index.
The tiny fixture selected a sequential scan for the QR ID/token `OR` lookup
despite both unique indexes being present. That small-fixture plan is not a
runtime blocker, but the production-sized staging plan must be reviewed before
cutover. Equal-timestamp comments still require the data-model decision above.

## 9. Isolated DTO Comparator

`comparePublicQrDtos()` accepts already-produced JSON and PostgreSQL candidate
DTOs. It compares:

- field presence;
- scalar type and value;
- `null` behavior;
- array length and order;
- nested object structure.

Its report contains only paths, mismatch categories, value types, and array
counts. It never prints field values, user content, phone, OpenID, account ID,
image URL, certificate URL, or provider payload.

The comparator is not called by a route and does not fetch either data source.
Production shadow reads remain disabled.

## 10. Errors

Compatible public route mappings remain:

- `QR_NOT_FOUND` -> 404
- `QR_HIDDEN` -> 403

Adapter-only readiness errors include:

- `PUBLIC_QR_KEY_REQUIRED`
- `PUBLIC_QR_CHANNEL_INVALID`
- `PUBLIC_QR_RUNTIME_METADATA_REQUIRED`
- `PUBLIC_QR_BATCH_REPOSITORY_GAP`
- `PUBLIC_QR_RECORD_MISSING`
- `PUBLIC_QR_IMAGE_RESOLVER_REQUIRED`
- `PUBLIC_QR_CERTIFICATE_RESOLVER_REQUIRED`
- `PUBLIC_QR_LIFECYCLE_INVALID`

These errors are not wired to HTTP responses in this phase.

## 11. Phase 2C-2B-3 Gap Decisions

### 11.1 Evidence Classes

The decisions below distinguish:

- `CODE_FACT`: proved by runtime code, tests, schema, or importer behavior;
- `FIXTURE_FACT`: proved only by artificial fixtures;
- `DATA_DISTRIBUTION_UNKNOWN`: requires a read-only production-backup audit;
- `PRODUCT_DECISION_REQUIRED`: cannot be decided safely from code alone.

Artificial fixtures do not establish production data distribution.

### 11.2 Unactivated Disclosure

This subsection records the Phase 2C-2B-3 pre-audit decision. Its
`BACKUP_AUDIT_REQUIRED` gate was subsequently satisfied, and its current
recommendation is superseded by the full submission-chain analysis in
Section 11.7.1.

| Item | Result | Evidence |
|---|---|---|
| JSON source | `qr_codes[].show_brand_disclosure` | `CODE_FACT` |
| New unactivated QR behavior | Seed and batch generation initialize the field to `false` | `CODE_FACT` |
| First durable user choice | Direct activation and co-creation start copy the authenticated submission choice and move the QR out of `unactivated` | `CODE_FACT` |
| H5 public behavior | The unactivated H5 DTO always includes the source boolean | `CODE_FACT` |
| Miniapp public behavior | The unactivated miniapp DTO omits the field | `CODE_FACT` |
| Current H5 client use | The record form uses the batch disclosure default and does not read the unactivated QR-level boolean | `CODE_FACT` |
| API compatibility | The field is still part of the H5 public response and cannot be removed solely because the current client ignores it | `PRODUCT_DECISION_REQUIRED` |
| PostgreSQL source | `records.show_brand_disclosure`; `qr_codes` has no equivalent field | `CODE_FACT` |
| Importer behavior | A normal unactivated QR does not create a record, so a QR-level historical value is not preserved | `CODE_FACT` |
| Historical distribution | Whether any production unactivated QR has a missing, non-boolean, or `true` value is unknown | `DATA_DISTRIBUTION_UNKNOWN` |

Decision:

- classify this as `BACKUP_AUDIT_REQUIRED`;
- retain `DATA_MODEL_GAP_UNACTIVATED_DISCLOSURE` until that audit and an API
  compatibility decision are complete;
- do not substitute the batch default, a record default, `null`, or a hardcoded
  value.

Conditional resolution:

1. If the backup audit proves every unactivated QR is absent/`false`, the API
   owner may formally freeze the H5 unactivated contract as `false`. That is an
   explicit compatibility decision, not an inferred fallback.
2. If any unactivated QR contains `true` or another meaningful historical
   value, add a dedicated QR-level compatibility field to the schema, preserve
   it in the importer, expose it through `QrRepository`, and repeat staging and
   DTO validation.
3. Removing the field requires a separately approved API normalization and
   client/consumer review.

This historical decision is no longer the current Gap 1 classification. The
audit found only false initialized values, and the later trace proved that the
user's durable choice is captured on the record at direct save or co-creation
start.

### 11.3 Equal-Timestamp Comment Order

| Item | Result | Evidence |
|---|---|---|
| JSON insertion | Comments are appended with `push()`; deletion maps rows in place and does not reorder the array | `CODE_FACT` |
| Current generated ID | New JSON comments use the current maximum numeric ID plus one | `CODE_FACT` |
| Public JSON order | Effective comments are stable-sorted by `created_at` descending; equal timestamps retain source-array order | `CODE_FACT` |
| Importer order | The importer visits comments in source-array order | `CODE_FACT` |
| Preserved legacy value | `legacy_comment_id` stores the source ID, or the source index only when the ID is missing | `CODE_FACT` |
| PostgreSQL model | No source-position column exists | `CODE_FACT` |
| PostgreSQL query | Effective comments are ordered by `created_at ASC, id ASC`, where `id` is a deterministic UUID | `CODE_FACT` |
| Adapter order | The adapter reverses timestamps stably, therefore preserving repository UUID order for ties rather than proving JSON source order | `CODE_FACT` |
| Artificial mismatch | A fixture with equal timestamps and non-positional string IDs produces only comment-order mismatch paths | `FIXTURE_FACT` |
| Historical distribution | Numeric-ID coverage, monotonicity, duplicate timestamps, and array/ID-order agreement are unknown | `DATA_DISTRIBUTION_UNKNOWN` |

`legacy_comment_id` is useful audit evidence but is not a universal source
ordinal: the accepted JSON model permits text IDs, and the importer does not
record the array index when an ID exists.

Decision:

- retain `DATA_MODEL_GAP_COMMENT_SOURCE_ORDER`;
- the compatibility-preserving recommendation is a `source_position` column
  populated from the original JSON array position;
- enforce one position per co-creation and query public comments by
  `created_at DESC, source_position ASC`;
- do not use UUID order, PostgreSQL physical order, or timestamp alone.

A production-backup audit may prove that every historical ID is numeric,
unique, and monotonic with source order. That could support a narrower
legacy-ID migration, but it still requires an explicit stable-order contract
for future PostgreSQL comments. An API ordering change is a product decision,
not an importer shortcut.

### 11.4 Read-Only Backup Audit Design

Phase 2C-2B-4 implements:

- `scripts/database/audit-public-qr-gap.js`;
- a fixed, explicit, read-only CLI contract;
- focused fixture tests for input gates, classification, redaction, and source
  immutability.

Run contract:

```text
node scripts/database/audit-public-qr-gap.js \
  --input=<absolute-structural-export-path> \
  --expected-source-sha256=<64-hex> \
  --dry-run
```

The input must be a pre-authorized structural export containing only QR
lifecycle, disclosure boolean, co-creation flag, and comment ID/time/status/
optional source-position fields. Unknown and sensitive fields are rejected, so
the tool cannot be pointed at a complete production JSON snapshot.

The tool:

- requires an explicitly supplied backup-copy path and expected SHA-256;
- rejects the default runtime database path;
- reads one immutable byte snapshot;
- avoids importing `dbService`, migrations, or any write helper;
- verifies SHA-256, raw `mtimeNs`, and file size are unchanged after analysis;
- emits counts, classifications, a path-hash prefix, and source SHA-256 only.

Required disclosure counts:

- total unactivated QR rows;
- field absent, `false`, `true`, and invalid-type counts;
- affected rows by issue status, without IDs or business content.

Required comment-order counts:

- total co-creations and comments;
- effective and deleted comment counts;
- equal-timestamp groups and affected comments;
- missing, duplicate, non-numeric, and non-monotonic comment IDs;
- groups where source-array order differs from numeric legacy-ID order.

The report must not include phone, OpenID, account ID mappings, user text,
addresses, image/certificate URLs, payment data, tokens, or secrets.

Tool implementation status:

- `TOOL_STATUS=COMPLETED`
- `STRUCTURAL_AUDIT_TOOL_USED=UNKNOWN`

The structural audit tool and its fixture tests remain separate from the
server-side data evidence recorded below. The server-side aggregation command
was not supplied, so the documentation does not claim that
`audit-public-qr-gap.js` produced those counts.

### 11.5 Server-Side Audit Evidence

Phase 2C-2B-5 records count-only evidence reported from a read-only aggregation
over a temporary server-side copy derived from the production JSON database.
The live `db.json` was not modified, no PostgreSQL production database was
connected, and the complete JSON copy was not transferred off the server.

Evidence metadata:

- `AUDIT_INPUT=AVAILABLE`
- `AUDIT_EXECUTION_STATUS=COMPLETED`
- `AUDIT_EXECUTION_METHOD=SERVER_SIDE_OFFLINE_AGGREGATION`
- `AUDIT_METHOD_VERIFIED=UNKNOWN`
- `AUDIT_SCOPE_DECLARED=YES`
- `AUDIT_SCOPE_VERIFIED=PARTIAL`
- `AUDIT_INPUT_INTEGRITY=PARTIAL`
- `AUDIT_EVIDENCE_CONFIDENCE=PARTIAL`
- `AUDIT_COPY_CLEANUP=PENDING`
- `AUDIT_RUN_AT_UTC=UNKNOWN`
- `SOURCE_COPY_CREATED_AT_UTC=UNKNOWN`
- `SERVER_REVISION_AT_AUDIT=UNKNOWN`
- `source_location=temporary-server-side-copy`
- `source_sha256_prefix=f263df13b5c1`

`AUDIT_INPUT_INTEGRITY` is `PARTIAL` because the available evidence includes a
source checksum but not a documented before/after checksum, size, and mtime
comparison. `AUDIT_METHOD_VERIFIED` is `UNKNOWN` because the aggregation
command or script was not supplied. `AUDIT_SCOPE_VERIFIED` is `PARTIAL`
because the reported scope is internally consistent but its implementation
has not been independently reviewed. Cleanup remains pending until deletion of
the temporary server-side copy is explicitly confirmed.

#### 11.5.1 CODE_FACT

- New QR creation initializes `show_brand_disclosure` to `false`.
- The H5 unactivated public DTO reads the QR-level disclosure field.
- The current PostgreSQL target model preserves disclosure on records, not on
  unactivated QR rows.
- JSON comments preserve source-array order for equal timestamps.
- The importer does not preserve an unconditional source position.
- The PostgreSQL repository's UUID tie-breaker does not prove equivalence with
  historical JSON source order.

#### 11.5.2 DATA_AUDIT_FACT

Reported unactivated QR disclosure distribution:

| Classification | Count |
|---|---:|
| Unactivated QR rows | 48 |
| `show_brand_disclosure=true` | 0 |
| `show_brand_disclosure=false` | 48 |
| Missing field | 0 |
| Invalid value | 0 |

Result:

- `GAP_1_DATA_EVIDENCE=NO_HISTORICAL_TRUE_FOUND`

This means only that the audited server-side copy contained no unactivated QR
with a true disclosure flag. It does not prove that no other historical
snapshot could contain one, close the compatibility gap, or authorize removal
of the field.

Reported co-creation comment distribution:

| Classification | Count |
|---|---:|
| QR/co-creations with comments | 2 |
| Total comments | 4 |
| Effective comments | 3 |
| Deleted comments | 1 |
| Missing timestamps | 0 |
| Invalid timestamps | 0 |
| Equal parsed-time groups | 0 |
| Comments in equal parsed-time groups | 0 |

The declared aggregation scope groups comments within each QR/co-creation,
counts deleted comments separately, and checks timestamp equality using the
value produced by `Date.parse(created_at)`.

Result:

- `GAP_2_DATA_EVIDENCE=NO_EQUAL_TIMESTAMPS_FOUND`

This means only that the audited copy did not exercise the equal-timestamp
boundary. It does not prove UUID ordering equivalent to JSON source order or
remove the need for a stable future ordering contract.

### 11.6 Shadow Read Gates

`SHADOW_READ_DESIGN_READY=YES`: comparison fields, redaction rules, known-gap
classification, and fail-closed behavior can now be designed.

`SHADOW_READ_EXECUTION_READY=NO`: the audit found no historical exceptions in
the supplied snapshot, but the two long-term compatibility rules remain
unfrozen, the evidence confidence is partial, and real external asset-resolver
behavior is still an external validation gate.

Comparator paths must not be ignored merely to report zero differences.

### 11.7 Phase 2C-2B-6A Compatibility Recommendations

This phase produces technical recommendations, not approved product contracts.
Code behavior and audit distribution are evidence, but neither constitutes
product approval.

Recommendation status:

- `COMPATIBILITY_CONTRACT_STATUS=PRODUCT_DECISION_REQUIRED`
- `IMPLEMENTATION_AUTHORIZED=NO`
- `ADAPTER_COVERAGE=PARTIAL`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

The audit provenance remains:

- `AUDIT_INPUT_INTEGRITY=PARTIAL`
- `AUDIT_EVIDENCE_CONFIDENCE=PARTIAL`
- `AUDIT_METHOD_VERIFIED=UNKNOWN`
- `AUDIT_SCOPE_VERIFIED=PARTIAL`
- `AUDIT_COPY_CLEANUP=PENDING`
- `AUDIT_RUN_AT_UTC=UNKNOWN`
- `SERVER_REVISION_AT_AUDIT=UNKNOWN`

#### 11.7.1 Gap 1 Recommendation

- `PREVIOUS_GAP_1_RECOMMENDATION=SUPERSEDED`
- `GAP_1_RECOMMENDATION=RECORD_LEVEL_PERSISTENCE`
- `GAP_1_UNACTIVATED_COMPATIBILITY=H5_FALSE_MINIAPP_OMIT`
- `GAP_1_CONTRACT_STATUS=RECOMMENDATION`

The earlier `FIX_FALSE_BY_RULE` wording was incomplete because it conflated an
unactivated response default with the user's durable display choice. The
business behavior to preserve is:

- the user sees a brand-disclosure switch while preparing an unactivated QR;
- enabling it means the saved record may display the captured disclosure on
  later scans;
- disabling it means the saved record must not display the disclosure;
- opening an unactivated page does not persist or claim that choice.

##### 11.7.1.1 Current H5 And Miniapp Flow

| Step | H5 evidence | Miniapp evidence | Compatibility meaning |
|---|---|---|---|
| Unactivated response | `src/server/routes/qr.js:145`, `src/server/routes/qr.js:191` | `src/server/routes/miniapp.js:176`, `src/server/routes/miniapp.js:226` | H5 includes a QR-derived false boolean; miniapp omits the field. Neither is the user's submitted choice. |
| Switch availability and default | `src/frontend/js/record.js:761`, `src/frontend/record.html:79` | `src/miniprogram/pages/record/record.js:207`, `src/miniprogram/pages/record/record.wxml:64` | The section is available only when batch disclosure text exists. Its initial state comes from the batch default. |
| Local user choice | `src/frontend/js/record.js:838` and the record draft | `src/miniprogram/pages/record/record.js:402` and the record draft | The user may override the default before submission; this state is local until submit. |
| API payload | `src/frontend/js/record.js:1015` | `src/miniprogram/pages/record/record.js:457` | Both send `show_brand_disclosure` with the direct or co-create submission. |
| Route normalization | `src/server/routes/qr.js:248` | `src/server/routes/miniapp.js:840` | Only the strict boolean value `true` enables disclosure; both paths pass the same semantic payload to `dbService`. |
| Direct persistence | `src/server/services/dbService.js:1195`, `src/server/services/dbService.js:1215` | Same shared service | Direct activation stores the boolean and captures the current batch disclosure text only when enabled. |
| Co-creation persistence | `src/server/services/dbService.js:1252`, `src/server/services/dbService.js:1269` | Same shared service | Starting co-creation stores the same boolean and text snapshot before the lifecycle becomes `co_creating`. |
| Finalize | `src/server/services/dbService.js:1373` | Same shared service | Finalize spreads the existing record aggregate and changes lifecycle/owner/proof fields without recalculating or replacing the disclosure choice. |
| Later display | `src/frontend/js/record.js:555` | `src/miniprogram/pages/result/result.js:59`, `src/miniprogram/pages/record-detail/record-detail.js:77` | Brand information is rendered only when the saved boolean is true and the saved disclosure text is non-empty. |

Both channels therefore share the same write semantics. Their unactivated DTO
shapes differ, but their submitted choice, persisted snapshot, and activated
display gate are equivalent.

During `co_creating`, authenticated public DTOs already contain the record
boolean and text snapshot. The current co-creation page UIs do not render a
brand block; finalize preserves the choice so the activated result can render
it. This is existing presentation behavior, not a PostgreSQL storage gap.

##### 11.7.1.2 Field Semantics

| Field | Source before submit | Durable source after submit | Rule |
|---|---|---|---|
| `batch_brand_disclosure_default` | Batch configuration | Not the user's choice | Initial switch suggestion only. |
| `batch_brand_disclosure_text` | Batch configuration | Source for capture at submit time | The switch is hidden when this text is empty. |
| `show_brand_disclosure` | Local switch state after page load | Record presentation choice | Persist strict boolean; false must suppress public display. |
| `brand_disclosure_text_snapshot` | Not an unactivated record field | Record text snapshot | Capture current batch disclosure text when enabled; otherwise persist an empty string. |
| `brand_name` | Batch configuration | Current batch lookup in existing presenters | Displayed only inside the disclosure block; it is not currently a record snapshot. |

The tests also establish that an enabled boolean with an empty batch
disclosure text produces an empty snapshot rather than falling back to an
unrelated batch note (`tests/api.test.js:2437`). Current frontends consequently
hide that disclosure block.

##### 11.7.1.3 PostgreSQL Mapping Recommendation

The normalized model already matches the durable business meaning:

- `app.qr_batches` retains the disclosure default and source text;
- `app.records.show_brand_disclosure` retains the user's submitted choice;
- `app.records.brand_disclosure_text_snapshot` retains the submit-time text;
- a `records` row is created for both `co_creating` and `activated` JSON
  aggregates (`scripts/database/importer/mapping.js:151`,
  `scripts/database/importer/mapping.js:193`);
- `finalize` updates lifecycle without moving or recreating that record;
- `RecordRepository` and `PublicQrReadAdapter` already read the record fields
  for `co_creating` and `activated` states.

The fact that JSON stores these values physically inside `qr_codes[]` is an
aggregate-storage artifact. Semantically they describe the record created by
the direct-save or co-creation-start submission.

Recommended minimum future work:

| Layer | Required | Reason |
|---|---|---|
| Schema | No | The record boolean and text snapshot already exist. |
| Migration | No | No new Gap 1 column is required. |
| Importer | No | Existing mapping writes both fields to `records`. |
| Repository | No | Existing record mapping exposes both fields. |
| Adapter | Yes | For unactivated H5 only, emit the compatibility boolean `false` without treating it as a persisted user choice. Preserve miniapp omission. |
| Comparator/tests | Yes | Prove H5 field presence/false, miniapp omission, and direct/co-create record persistence. |

No QR-level PostgreSQL disclosure column is recommended. Such a column would
be required only if a future product rule allows disclosure to be durably
published before a direct-save or co-creation-start submission.

#### 11.7.2 Gap 2 Recommendation

- `GAP_2_RECOMMENDATION=SOURCE_POSITION_REQUIRED`
- `GAP_2_CONTRACT_STATUS=PRODUCT_DECISION_REQUIRED`

Recommended stable-order contract:

- add a zero-based, non-negative `source_position` within each co-creation;
- import the original JSON array index for every historical comment;
- retain positions for effective and deleted comments;
- never renumber remaining comments after deletion;
- require one unique `(co_creation_id, source_position)` pair;
- exclude deleted comments from the public DTO under the existing visibility
  rule;
- order visible comments by
  `created_at DESC, source_position ASC`.

Reasons:

1. This reproduces the current JSON stable-sort tie behavior directly.
2. UUID, PostgreSQL physical order, and timestamp alone cannot preserve source
   order.
3. `legacy_comment_id` is not a universal ordinal because accepted historical
   IDs may be textual or otherwise unrelated to array position.
4. The audit found no equal timestamp group, but that only means the current
   snapshot did not exercise the boundary.

Risks and implementation boundary:

- new-comment position allocation must be transaction-safe and is deferred to
  the later PostgreSQL write-path design;
- the next implementation phase must choose a safe migration strategy for any
  already-applied schema rather than editing a released migration by default;
- the repository query and supporting index must use the frozen ordering;
- adapter DTO shape should remain unchanged; only deterministic row order
  should change.

If approved, schema, migration, importer, repository, fixtures, and offline
comparison require a separately scoped Phase 2C-2B-7 implementation and fresh
PostgreSQL staging validation.

#### 11.7.3 Approval Gate

No recommendation above is frozen by this document. Product approval must
explicitly accept or reject each recommendation. Until then:

- `IMPLEMENTATION_REQUIRED=UNDECIDED`
- `OFFLINE_REVALIDATION_REQUIRED=NO`
- Phase 2C-2B-7 is not authorized;
- Shadow Read execution remains prohibited.

If both recommendations are approved, the status may be updated to
`COMPATIBILITY_CONTRACT_STATUS=FROZEN`,
`IMPLEMENTATION_REQUIRED=YES`, and
`OFFLINE_REVALIDATION_REQUIRED=YES` before implementation begins.

## 12. Completion And Next Gate

Phase 2C-2B-2 reports implementation work completed while adapter coverage is
partial and runtime readiness remains not ready.

Phase 2C-2B-3 freezes the decision boundary; it does not close the gaps.

Before any runtime shadow read:

1. Freeze the unactivated H5 disclosure compatibility strategy.
2. Freeze the stable comment ordering contract, including whether
   `source_position` is required.
3. Implement any approved schema, migration, importer, repository, adapter,
   and comparator changes as a separately scoped phase.
4. Re-run migration, importer dry-run, staging import, count/relationship
   conservation, repository SQL, and offline H5/miniapp DTO comparison.
5. Confirm image and certificate URL resolver behavior outside database
   transaction windows.
6. Review production-sized query plans and comment bounds.
7. Freeze Shadow Read comparison fields, redaction, mismatch retention, and
   abort rules.

The next phase must not jump directly to Shadow Read execution. If data-model
work is required, complete it and repeat PostgreSQL staging and offline DTO
validation first. Phase 2D begins with Shadow Read design only after the gaps
are closed or have formally approved compatibility strategies.

No PostgreSQL runtime read switch is ready from this phase alone.

### 11.8 Phase 2C-2B-7 Approved Contract And Implementation

The product owner approved both Phase 2C-2B-6A recommendations and authorized
the minimum offline implementation. This approval does not authorize runtime
PostgreSQL reads or Shadow Read execution.

Frozen compatibility contract:

- `GAP_1_DECISION=RECORD_LEVEL_PERSISTENCE`
- H5 unactivated DTO always includes `show_brand_disclosure=false`.
- Miniapp unactivated DTO continues to omit `show_brand_disclosure`.
- Neither unactivated shape represents a persisted user choice.
- `co_creating` and `activated` continue to read the submitted choice and text
  snapshot from `records`.
- `GAP_2_DECISION=SOURCE_POSITION_REQUIRED`
- Every historical JSON comment, including deleted comments, retains its
  zero-based array index as `source_position`.
- Positions are unique per co-creation and are never renumbered.
- Deleted comments remain stored but stay outside the public DTO.
- Visible comments use
  `created_at DESC, source_position ASC`.
- `source_position` is internal and never appears in the public DTO.

Implementation:

- migration `001_init_schema.sql` remains byte-for-byte unchanged;
- migration `002_add_comment_source_position.sql` adds the non-negative field,
  per-co-creation uniqueness, and a kept-comment source-order index;
- `002` refuses to infer positions when PostgreSQL already contains comments,
  so staging must be rebuilt and imported from JSON;
- the importer maps the original array index without sorting and validates
  uniqueness, source correspondence, and count conservation;
- post-import verification checks contiguous zero-based positions;
- `CoCreationRepository` exposes deterministic source order without UUID
  ordering;
- `PublicQrReadAdapter` applies the frozen public order and fails closed when a
  kept PostgreSQL comment has no valid position.

Production-snapshot compatibility extension:

- Migration `003_preserve_legacy_import_evidence.sql` adds internal
  `legacy_duplicate` and `legacy_hash_snapshot` fields without changing the
  public DTO.
- Distinct historical comments from the same account remain visible in their
  normal timestamp/source-position order. The internal exception flag is
  never serialized.
- A historical non-SHA value stored identically in the two JSON proof aliases
  is preserved internally and projected back to the existing
  `blockchain_hash`/`manifest_hash` DTO fields. Canonical PostgreSQL proof
  hashes remain strict SHA-256.
- Missing historical record/comment account links may be recovered only by the
  importer's unique exact phone-to-account mapping. Adapter ownership checks
  continue to use account IDs only.

Disposable PostgreSQL 15.18 validation:

- existing-comment `002` execution failed as designed and the migration
  transaction left neither the column nor an applied-version row;
- a fresh database applied `001` then `002`, and a second migration run had
  zero pending migrations;
- importer analysis returned READY and staging import verification passed;
- kept and deleted comments preserved positions `0`, `1`, and `2`;
- H5 and miniapp unactivated, co-creating, activated proof, and equal-timestamp
  comment DTO comparisons produced `mismatch_count=0`;
- no route, runtime selector, JSON write path, or production database was
  involved.

Migration `003` revalidation used a fresh disposable PostgreSQL 15.18 database.
The focused legacy fixture and the complete Public QR/Shadow integration both
passed with `mismatch_count=0`; the test instances and data directories were
removed afterward. Server-side staging validation against the fixed audited
snapshot remains required before Shadow Read can be enabled.

Resulting status:

- `WORK_STATUS=COMPLETED`
- `COMPATIBILITY_CONTRACT_STATUS=FROZEN`
- `IMPLEMENTATION_STATUS=COMPLETED`
- `ADAPTER_COVERAGE=COMPLETE`
- `OFFLINE_PG_VALIDATION=PASSED`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

The historical audit evidence remains partial; this implementation does not
upgrade its integrity, cleanup, time, or server-revision claims. The next phase
may design Shadow Read gates, but must not enable runtime comparison until URL
resolver behavior, mismatch redaction/retention, query bounds, and abort rules
are frozen and reviewed.

### 11.9 Phase 2D-0 Audit Baseline

The cumulative worktree and the real H5/miniapp public route chains are
recorded in
[phase-2d-0-workspace-baseline.md](phase-2d-0-workspace-baseline.md).

The audit confirms:

- the current server startup, routes, middleware, and business services do not
  import PostgreSQL connections, repositories, this Adapter, or the DTO
  comparator;
- existing JSON presenters remain the only runtime response source;
- the future observer belongs after each JSON presenter produces its final
  `data` DTO, with baseline response delivery independent from Candidate work;
- the first observation design should cover successful DTOs only unless a
  separate error-outcome comparator is approved;
- mismatch reports may contain only channel, lifecycle, path, kind, types,
  counts, truncation, and non-reversible operational correlation metadata;
- production resolver equivalence and keeping network resolution outside a
  PostgreSQL transaction are unresolved execution gates;
- effective comments are business-limited to 12, but the Candidate repository
  currently has no SQL overflow guard.

At the Phase 2D-0 audit snapshot, status was:

- `WORKTREE_AUDIT_STATUS=PARTIAL`
- `RUNTIME_PATH_UNCHANGED_BY_POSTGRES_PHASES=YES`
- `MIGRATION_FILESET_STATUS=PASS`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

Phase 2D-0 adds no runtime observer, feature flag, PostgreSQL request traffic,
dual read, or dual write.

### 11.10 Group E Submission Baseline

The reviewed Candidate was committed as `aa613c6`. Its commit tree is
`33e7e9999d883b68a6e0d8d176a3640929ccaf2a`, identical to the
independently tested candidate tree.

Validation evidence:

- offline candidate snapshot: 154/154 tests passed;
- focused Adapter and audit tests: 23/23 passed within that same tree;
- disposable PostgreSQL version: 15.18;
- manual Public QR integration: 1/1 passed;
- JSON/PostgreSQL public DTO mismatch count: zero;
- temporary PostgreSQL instance, log, and data directory cleanup: passed.

Current status:

- `WORKTREE_AUDIT_STATUS=PASS`
- `COMMIT_BOUNDARY_EXECUTION=COMPLETE`
- `ADAPTER_COVERAGE=COMPLETE`
- `OFFLINE_PG_VALIDATION=PASSED`
- `PUBLIC_QR_INTEGRATION_STATUS=PASSED`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

The audit evidence status remains `AUDIT_INPUT_INTEGRITY=PARTIAL`,
`AUDIT_EVIDENCE_CONFIDENCE=PARTIAL`, and
`AUDIT_COPY_CLEANUP=PENDING`. Group E validation does not upgrade those
separate server-side evidence claims.

### 11.11 Phase 2D-1 Shadow Read Design Review

The reviewed design is recorded in
[shadow-read-design-v1.md](shadow-read-design-v1.md).

The real H5 and miniapp routes remain unchanged. A future observer belongs
after the current presenter has created its final channel-specific `data` DTO.
The existing JSON response must finish without awaiting Candidate work, and
JSON remains authoritative for status, headers, and body.

The design closes the architecture questions required to begin a separate,
default-off implementation phase:

- Candidate receives only the normalized lookup key, channel, and trusted
  server-derived viewer context in memory; none may enter telemetry.
- Full public DTO shape and values are compared after equivalent asset
  resolution. Internal fields are absent rather than ignored.
- A comparison is eligible only when source-version evidence captured with the
  baseline JSON read exactly matches a passed PostgreSQL import source hash.
- PostgreSQL row reads use a short read-only transaction; URL resolution occurs
  only after release.
- effective comments use the frozen public order and a future 13-row SQL probe
  to enforce the legal maximum of 12 without silent truncation.
- runtime protection is default-off, bounded, low-concurrency, sampled, and
  protected by a circuit breaker and a dedicated value-free sink.

The current code does not yet provide atomic JSON source-version evidence, a
two-phase Candidate query/resolver boundary, the SQL overflow probe, runtime
controls, or the dedicated sink. Those are implementation and execution gates,
not reasons to weaken comparison.

Result:

- `SHADOW_READ_DESIGN_STATUS=COMPLETE`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_GO_NO_GO=GO`
- `SHADOW_READ_GO_SCOPE=DEFAULT_OFF_IMPLEMENTATION_ONLY`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`

This result does not authorize Shadow Read execution, PostgreSQL request
traffic, a production database connection, or deployment.
