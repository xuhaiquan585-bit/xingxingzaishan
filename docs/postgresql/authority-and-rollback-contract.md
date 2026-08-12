# PostgreSQL Authority and Rollback Contract

## Purpose

This contract defines when JSON or PostgreSQL is authoritative, what marks the
cutover commit point, and which rollback actions are allowed. It prevents a
runtime toggle from hiding data created after PostgreSQL becomes authoritative.

The current production state is `JSON_AUTHORITY`:

- JSON remains the business authority.
- Every PostgreSQL primary read/write runtime is disabled.
- PM2 has no database secret and no PostgreSQL connection.
- Controlled and isolated PostgreSQL validation does not change authority.

## Authority states

### 1. JSON_AUTHORITY

JSON is the only writable authority. PostgreSQL can be audited or tested only
through disposable databases or explicitly bounded, reversible validation.
Production primary selectors must remain disabled after each validation.

### 2. CUTOVER_FROZEN

Business writes are paused for a short maintenance window. Before leaving this
state, the operator must capture and verify:

- the exact deployed Git commit and tree;
- the protected JSON SHA-256;
- a PostgreSQL backup and its SHA-256;
- `pg_restore --list` readability for the backup;
- canonical migrations and public QR domain provenance;
- zero unexpected PostgreSQL connections and zero active proof work;
- all in-scope PostgreSQL authority selectors configured as `scope=all`
  without allowlists, with out-of-scope external runtimes explicitly disabled;
- producer, privacy, monitoring, auto-off, and rollback gates.

No long-term JSON/PostgreSQL dual-write is required. The maintenance freeze is
the consistency boundary. The application enforces it with
`POSTGRES_CUTOVER_WRITE_FREEZE_ENABLED=true`: only `GET`, `HEAD`, and `OPTIONS`
requests are admitted, while every other HTTP method fails with a generic
maintenance response before body parsing, sessions, or business routes.

### 3. POSTGRES_AUTHORITY_PREWRITE

The coordinated PostgreSQL runtime is enabled, but no PostgreSQL-only business
write has committed. Existing H5 and miniapp routes must pass the complete
read-only acceptance suite.

During this state, the checked-out mapping code pins two independent hashes:
the current JSON authority baseline and the clean PostgreSQL target domain.
Route context must match the former, while PostgreSQL provenance and canonical
migrations must match the latter. An intentional privacy or legacy-data delta
therefore does not weaken either check or require the two domains to be equal.

Rollback to `JSON_AUTHORITY` is still allowed in this state because JSON has not
missed a committed business mutation.

### 4. POSTGRES_AUTHORITY_COMMITTED

The first committed PostgreSQL-only identity, QR issuance, lifecycle, record,
or proof mutation is the authority commit point. From that instant:

- PostgreSQL is the durable business authority;
- JSON must not be re-enabled as a complete primary source;
- disabling PostgreSQL selectors without a verified data conversion is
  prohibited;
- operational rollback means deploying the last known-good PostgreSQL-compatible
  release, pausing affected writes, or restoring a PostgreSQL backup;
- a return to JSON requires a separately implemented, audited PostgreSQL-to-JSON
  export with full count, identity, lifecycle, ownership, and asset parity.

### 5. JSON_ARCHIVE

After the stable observation period, the protected JSON snapshot becomes a
read-only historical artifact. It is retained for audit and recovery evidence,
not as a live fallback authority.

## Stable producer prerequisites

The authority commit point is blocked until all producers are durable in
PostgreSQL:

1. Admin QR issuance creates issued QR rows and access tokens in PostgreSQL.
   A referenced batch must already be PostgreSQL-authoritative; stable use of
   newly created batches additionally requires the batch-management producer.
2. H5 and miniapp identity creation, phone/OpenID binding, and authenticated
   identity lookup use PostgreSQL authority.
3. QR activation, co-creation, comment, and finalization writes use PostgreSQL.
4. Direct activation and finalization enqueue proof work atomically. The
   durable outbox row is part of the PostgreSQL migration; external proof
   submission is not.
5. The proof worker remains explicitly disabled while AVATA is outside the
   migration scope. Pending proof jobs are preserved for a separate provider
   enablement project and no placeholder credentials or mock confirmations are
   allowed in production.
6. Personal and public read routes use PostgreSQL for current and future
   entities under explicit `scope=all` configuration.

Producer completion is proven by repository tests, disposable PostgreSQL
integration, and a coordinated production-host rehearsal. A code deployment by
itself does not satisfy this gate.

## Rollback decision table

| State | JSON fallback allowed | Required response |
| --- | --- | --- |
| `JSON_AUTHORITY` | Yes | Keep PostgreSQL selectors disabled. |
| `CUTOVER_FROZEN` | Yes | Abort cutover and resume existing JSON writes. |
| `POSTGRES_AUTHORITY_PREWRITE` | Yes | Auto-off all selectors together, verify no PostgreSQL-only mutation, then resume JSON. |
| `POSTGRES_AUTHORITY_COMMITTED` | No | Pause affected writes and keep PostgreSQL authoritative; forward-fix, deploy a known-good PostgreSQL-compatible release, or restore PostgreSQL. |
| `JSON_ARCHIVE` | No | Treat JSON only as recovery evidence unless a verified export has rebuilt it. |

## Coordinated configuration rule

Stable configuration is one root-owned `0600` environment file. Public QR
primary read, personal record primary read, lifecycle write, identity authority,
and QR issuance authority are reviewed and activated as one release operation.
Stable `scope=all` settings must not carry a static allowlist. While AVATA is
outside the PostgreSQL migration scope, the same file must explicitly set
`RECORD_PROOF_RUNTIME_ENABLED=false` and must not include proof-worker scope,
provider credentials, or callback configuration.

The file must also contain the preflight-pinned
`POSTGRES_AUTHORITY_BASELINE_DOMAIN_SHA256`. Public read, personal read, and
lifecycle write compare JSON-derived route context to that baseline; their
individual domain selectors continue to identify the PostgreSQL target.

The stable configuration must never be assembled by mixing old controlled
cohort files. PM2 saves it only after the coordinated acceptance passes.

## Failure handling

Any of the following blocks authority advancement and triggers write freeze or
prewrite auto-off:

- provenance or migration drift;
- DTO identity or ownership mismatch;
- unexpected JSON mutation;
- PostgreSQL connection or statement timeout errors above the accepted gate;
- unexpected outbox state, exhausted retries, or proof callback conflict when
  the separately authorized proof runtime is enabled;
- privacy gate failure;
- asset accessibility failure;
- inability to verify the backup or rollback target.

Failure evidence must remain value-free: no database passwords, access tokens,
phone numbers, OpenIDs, raw record content, or signed asset URLs.

## Current decision

The project uses a short maintenance freeze and an explicit authority commit
point instead of long-term dual-write. This is appropriate while all accounts
are test accounts and no real customer traffic exists. The decision must be
reviewed before real-customer enablement if availability or zero-downtime
requirements change.
