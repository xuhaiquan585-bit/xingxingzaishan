# Public QR Shadow Read Design v1

## 1. Scope And Decision Status

This document designs the first runtime observation boundary for the existing
H5 and miniapp Public QR reads. It does not implement or enable that boundary.

The design has two separate gates:

- `SHADOW_READ_IMPLEMENTATION_GO=GO`: a later phase may implement the observer
  with its runtime switch defaulted off.
- `SHADOW_READ_EXECUTION_READY=NO`: this document does not authorize a runtime
  comparison, PostgreSQL request traffic, or deployment.

Current status:

- `SHADOW_READ_DESIGN_STATUS=COMPLETE`
- `SHADOW_READ_DESIGN_READY=YES`
- `SHADOW_READ_GO_NO_GO=GO`
- `SHADOW_READ_GO_SCOPE=DEFAULT_OFF_IMPLEMENTATION_ONLY`
- `SHADOW_READ_EXECUTION_READY=NO`
- `RUNTIME_READINESS=NOT_READY`
- `BASELINE_RESPONSE_SOURCE=JSON`
- `CANDIDATE_RESPONSE_SOURCE=OBSERVATION_ONLY`

JSON remains the sole source of HTTP status, headers, and response content.
Candidate work must never change a user-visible result.

## 2. Real Runtime Paths

### 2.1 H5

```text
createApp()
  -> attachUserSession()
  -> GET /api/qr/:qrId
  -> findQRByKey(req.params.qrId)
  -> not-found and hidden checks
  -> formatQRStatusPayload(qr, req)
  -> res.json({ status: "success", code: "OK", data })
```

The H5 presenter uses trusted `req.user` state for co-creation visibility and
ownership. An unactivated H5 DTO always includes
`show_brand_disclosure=false`.

### 2.2 Miniapp

```text
GET /api/miniapp/qr/:key
  -> optionalMiniappAuth
  -> findQRByKey(req.params.key)
  -> not-found and hidden checks
  -> formatQRPayload(qr, req.miniappUser)
  -> res.json({ status: "success", code: "OK", data })
```

The miniapp presenter uses the authenticated miniapp user for `phone_bound`,
co-creation visibility, ownership, and comment markers. An unactivated
miniapp DTO omits `show_brand_disclosure`.

The first implementation covers successful 200 `data` DTOs only. Not-found,
hidden, unauthorized, and other outcome envelopes require a separate approved
outcome comparator and are not silently treated as DTO mismatches.

## 3. Insertion Point And Baseline Isolation

`SHADOW_INSERTION_POINT=AFTER_FINAL_JSON_DTO_BEFORE_RESPONSE_FINISH_HOOK`

Each route should first build the existing final JSON DTO without changing its
presenter. It may then register a no-throw observer callback on the response
`finish` event and send the existing response normally. The observer receives
a defensive copy of the final `data` DTO and starts only after the baseline
response has finished.

This ordering is required:

```text
build existing JSON data DTO
  -> capture observation input in memory
  -> register bounded finish callback
  -> send unchanged JSON response
  -> after finish, scheduler may accept or skip observation
  -> PostgreSQL Candidate
  -> comparator
  -> redacted sink
```

The finish callback must catch synchronous and asynchronous failures. A full
queue, disabled switch, stale source, timeout, PostgreSQL error, resolver
error, or comparator mismatch cannot call `next()`, write to `res`, alter the
status code, or delay response completion.

The observer may receive these values in memory:

- normalized QR lookup key required by `PublicQrReadAdapter`;
- channel: `h5` or `miniapp`;
- trusted viewer context derived by server middleware: account ID and
  phone-bound boolean only;
- defensive copy of the final baseline DTO;
- source-version evidence captured from the same JSON read snapshot.

The lookup key may be an access token and the account ID is an internal
identifier. Neither may enter logs, metrics labels, mismatch records, error
messages, or traces. Phone, OpenID, session/token values, and request body or
query identity values must not be passed to Candidate code.

## 4. Candidate Read Boundary

Candidate work is asynchronous, read-only, timeout-bounded, and disposable.
It must use repositories through one injected read-only transaction context.
No repository or Adapter may create its own pool or commit a transaction.

The Candidate read has two phases:

1. Inside a short `READ ONLY` PostgreSQL transaction, fetch QR, batch, record,
   co-creation, effective comments, proof, and observation-version metadata.
2. Commit/release the transaction, then assemble the public DTO and resolve
   image/certificate URLs through the approved channel-aware resolver.

`DB_TRANSACTION_SCOPE=POSTGRES_ROWS_AND_VERSION_METADATA_ONLY`

The current `PublicQrReadAdapter.read()` performs row reads and asset
resolution in one method. Phase 2D-2 must introduce a reviewed two-phase
orchestration boundary before runtime execution; it must not hold a database
client while generating signed URLs or waiting on external services.

Candidate input must use the same normalized lookup value and the same trusted
viewer semantics as the baseline route. Candidate output must be only the
channel-specific public DTO. Internal PostgreSQL UUIDs, `source_position`,
account IDs, owner IDs, and access tokens must never enter that DTO.

## 5. Freshness And Eligibility

The existing PostgreSQL data is an imported snapshot while JSON remains
mutable. Import completion time is not source freshness and must not be used
as a substitute for source identity.

`IMPORT_WATERMARK` consists of:

- SHA-256 of the exact JSON source snapshot;
- passed `import_runs` row and importer version;
- migration set/checksums used by that import;
- Candidate observer version.

For the first implementation, a comparison is eligible only when the JSON
source hash captured from the same baseline read snapshot exactly equals the
source SHA-256 of the selected passed import run. This intentionally
conservative global gate prevents a change elsewhere in JSON from being
misclassified as a DTO regression.

Current `findQRByKey()` does not return source-version evidence. Phase 2D-2
must design a side-channel/result wrapper that obtains the QR value and source
hash from the same read snapshot without changing the public DTO or performing
a second racy read. Until that exists, execution is blocked.

`STALE_DATA_POLICY`:

- no passed import run: `INELIGIBLE_NO_IMPORT`;
- source hash missing or not captured atomically: `INELIGIBLE_NO_VERSION`;
- source SHA differs from the import run: `STALE_SOURCE`;
- Candidate version/importer/migration set not approved: `INELIGIBLE_VERSION`;
- only exact eligible snapshots enter DTO comparison;
- stale/ineligible observations increment count-only operational counters and
  are never reported as mismatches.

No JSON/PostgreSQL dual write is permitted. A later design may add a proven
per-aggregate fingerprint to increase coverage, but timestamps alone are not
sufficient because proof/archive updates do not consistently advance one QR
aggregate timestamp.

## 6. Comparator Contract

`COMPARATOR_SCOPE=COMPLETE_CHANNEL_SPECIFIC_PUBLIC_DATA_DTO`

The comparator receives the final H5 or miniapp baseline `data` DTO and the
equivalent Candidate DTO after resolver processing. It compares complete
field presence, scalar values, object keys, array lengths, and array order.
Channel-specific omission is part of the contract; for example, H5 and
miniapp unactivated disclosure shapes are intentionally different.

There is no broad ignore list. Internal fields are excluded by never placing
them in either public DTO. The comparator must continue to emit only field
paths, difference kinds, value types, and bounded counts; it must not emit
values.

Asset fields remain part of the public DTO contract. They may be compared only
after the resolver policy in Section 7 is proven. A missing external resolver
is an execution gate, not permission to use empty strings or ignore URL paths.

## 7. Asset And URL Resolution

Current behavior differs by channel:

- H5 image resolution signs an object key and otherwise uses the stored URL.
- Miniapp image resolution prefers an existing URL, then a public object URL,
  then a signed URL.
- Certificate resolution signs a certificate object key and otherwise uses
  the provider URL snapshot.

Phase 2D-2 must provide one channel-aware resolver contract that reproduces
these rules for Candidate rows. It must be tested in the production-equivalent
storage mode without recording object keys or resolved URLs.

Signed URLs are time-dependent. Exact DTO comparison is allowed only when the
baseline and Candidate use one request-scoped memoized resolution result for
the same asset input, or another reviewed resolver mechanism proves byte-level
equivalence. Removing signature parameters or ignoring URL fields is not an
approved shortcut.

Resolver errors classify the observation as `CANDIDATE_RESOLVER_ERROR`; they
do not create a DTO mismatch and do not affect the user response.

## 8. Comment Bound And Query Shape

The existing write path permits at most 12 effective comments. The existing
public presenters return all effective comments, ordered by
`created_at DESC` with source-array order as the stable tie-breaker. The
approved PostgreSQL tie-breaker is `source_position ASC`.

`COMMENT_LIMIT_POLICY=FETCH_13_TO_ENFORCE_MAX_12_WITHOUT_TRUNCATION`

Phase 2D-2 must make the Candidate comment query use:

```text
WHERE status = 'kept'
ORDER BY created_at DESC, source_position ASC
LIMIT 13
```

Zero through 12 rows are passed to the Adapter unchanged. Thirteen rows mean
`CANDIDATE_COMMENT_OVERFLOW`; the Candidate is rejected as an integrity
failure rather than silently truncated. JSON still determines the user
response. The query must remain one bounded query, with no per-comment N+1
lookups.

## 9. Runtime Protection Policies

These are initial implementation values and must be verified against staging
latency before any execution approval:

- `SHADOW_READ_DEFAULT=OFF`;
- `CANDIDATE_TIMEOUT_POLICY=250_MS_TOTAL_BUDGET`;
- `CANDIDATE_CONCURRENCY_POLICY=MAX_2_PER_PROCESS_NO_QUEUE`;
- when both slots are occupied, skip and count `SKIPPED_CAPACITY`;
- pool acquisition, SQL, resolver, and comparison share the one total budget;
- timers and acquired resources must be released on every outcome.

`CANDIDATE_ERROR_POLICY=BASELINE_UNCHANGED_REDACTED_COUNTER_ONLY`

`CIRCUIT_BREAKER_POLICY`:

- infrastructure failures include timeout, pool/connect/query failure,
  resolver failure, and sink failure;
- five infrastructure failures in a rolling 60-second window open the circuit
  for five minutes;
- one half-open probe is allowed after the interval;
- a failed probe reopens the circuit; a successful probe closes it;
- stale/ineligible/skipped observations and DTO mismatches do not count as
  infrastructure failures;
- any mismatch blocks sampling expansion and triggers review, but cannot alter
  the response.

## 10. Sampling Policy

`SAMPLING_POLICY=OFF_THEN_ALLOWLIST_THEN_DETERMINISTIC_LOW_PERCENTAGE`

Rollout order after a separate execution approval:

1. Off by default in every environment.
2. Explicit fixed test QR IDs in protected runtime configuration.
3. Deterministic 0.1% sampling using HMAC-SHA-256 over a non-secret public QR
   ID and a dedicated Shadow Read sampling secret.
4. Increase to 1% only after an approved observation window has zero
   unexplained mismatches, acceptable latency, and no circuit opening.

No access token is used as a metrics label or persisted allowlist value. Raw
QR IDs and sampling HMACs are not written to mismatch records. Broad or 100%
sampling requires a new review; it is not authorized here.

## 11. Mismatch Sink And Privacy

`MISMATCH_STORAGE_POLICY=DEDICATED_REDACTED_OPERATIONAL_TELEMETRY`

Do not reuse the current synchronous audit JSONL writer: it records raw request
paths and performs synchronous file I/O. The future sink must be a dedicated,
bounded, asynchronous operational telemetry interface.

Allowed fields:

- UTC timestamp;
- endpoint template (`/api/qr/:key` or `/api/miniapp/qr/:key`), never raw URL;
- channel and lifecycle;
- observer/importer/migration version references;
- field path, difference type, baseline/candidate value types;
- array counts, total mismatch count, and truncation flag;
- outcome class and latency bucket;
- random observation ID that has no identity meaning.

Forbidden fields:

- QR key/access token or raw QR ID;
- account/owner/user IDs, phone, OpenID, session or authorization data;
- content, author name, comment text, image/object key, any URL;
- provider payload, address, IP, user agent, or compared values;
- reversible or unsalted hashes of the above values.

Raw redacted observations are restricted to operations/database-migration
reviewers and retained for 14 days. Count-only aggregates may be retained for
90 days. Both require automated expiry and an access audit before execution.
Sink failure drops the observation and contributes to the circuit breaker; it
never falls back to application console output.

## 12. Disable And Rollback Policy

`ROLLBACK_POLICY=DISABLE_OBSERVER_WITH_DEFAULT_OFF_RUNTIME_CONFIG`

The later implementation may introduce one explicit runtime switch, default
off, scoped only to Public QR observation. When off:

- no PostgreSQL pool is initialized for Shadow Read;
- no finish callback schedules Candidate work;
- JSON routes and presenters execute exactly as before;
- no mismatch sink is required.

The first response to operational trouble is to turn the switch off and
restart the service under the existing deployment procedure. Circuit opening
provides automatic containment, but is not a substitute for the switch.
Deployment rollback to the pre-observer commit is the second option. Neither
action changes JSON data or requires a database rollback.

## 13. GO / NO-GO Gates

### 13.1 Phase 2D-2 Default-Off Implementation

Design review result: `SHADOW_READ_GO_NO_GO=GO` with
`SHADOW_READ_GO_SCOPE=DEFAULT_OFF_IMPLEMENTATION_ONLY`.

The implementation may proceed only within a separate scope and must keep the
switch off. It must add tests proving no response mutation, no unhandled
rejection, and no PostgreSQL pool initialization while off.

### 13.2 Shadow Read Execution

Execution remains `NO_GO` until all of these are complete:

- baseline read returns atomic source-hash evidence without changing its DTO;
- latest passed import provenance is selected and exact-hash eligibility is
  enforced;
- Candidate row reads and asset resolution are separated by transaction end;
- production-equivalent H5/miniapp resolver output passes value-free tests;
- comment query is bounded with the 13-row overflow rule;
- timeout, concurrency, circuit breaker, sampling, and no-throw finish hook are
  implemented and reviewed;
- dedicated sink access, retention, expiry, and failure behavior are approved;
- fresh staging import and offline H5/miniapp DTO comparison pass;
- a clean backup/import rehearsal and disposable PostgreSQL validation pass;
- operating procedure confirms enable, disable, observation, and abort steps.

Immediate `NO_GO` conditions include Candidate influence on a response,
unknown freshness, sensitive telemetry, missing disable mechanism, resolver
inequivalence, an unbounded comment query, or any runtime dual write.

## 14. Non-Goals

This design does not create an observer, feature flag, sink, runtime pool,
route hook, or PostgreSQL traffic. It does not change JSON queries, presenters,
DTOs, authentication, migration files, importer, repositories, Adapter,
Comparator, schema, or production configuration.
