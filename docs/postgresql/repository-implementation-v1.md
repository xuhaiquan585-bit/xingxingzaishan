# PostgreSQL Repository Implementation v1

## 1. Phase status

Phase 2C-1 establishes an isolated PostgreSQL repository foundation. It does not connect any route or service to PostgreSQL. The JSON `dbService` remains the only runtime business data source.

Phase 2B-2.5 staging execution completed against disposable local PostgreSQL 15.18 databases. Phase 2C-1 repository contracts remain primarily covered by fake `TransactionContext` tests; the public QR read subset has additionally executed against PostgreSQL during Phase 2C-2B-2.

## 2. Domain boundary

The `users` table stores login identities. A user row is not the business principal. Business ownership belongs to `accounts` and is referenced through `account_id`.

Phone and OpenID are identity credentials or external-provider snapshots. Record, co-creation, order, payment, and proof ownership must not fall back from `account_id` to phone or OpenID.

## 3. TransactionContext

Every repository constructor requires an injected object with:

```js
{
  query(sql, params): Promise<{ rows, rowCount }>
}
```

Repositories do not import the PostgreSQL connection layer, create a `Pool` or `Client`, read environment variables, or execute `BEGIN`, `COMMIT`, or `ROLLBACK`. Future application services will open transactions with `withTransaction()` and pass the resulting context into all repositories participating in that transaction.

Methods ending in `ForUpdate` issue `FOR UPDATE` and may only be called with a context already bound to an active transaction. Repository implementations never commit cross-domain work.

## 4. Implemented repositories

| Repository | Tables | Implemented methods |
|---|---|---|
| `AccountRepository` | `accounts` | `findById`, `findByIdForUpdate`, `exists`, `insert` |
| `IdentityRepository` | `users` | `findById`, `findByIdForUpdate`, unique phone/OpenID lookups and lock variants, `listByAccountId`, `countByAccountId`, `insert` |
| `QrRepository` | `qr_codes` | ID/token/key lookups, ID/key lock variants, conditional `updateLifecycle` |
| `QrBatchRepository` | `qr_batches` | public projection lookup by ID |
| `RecordRepository` | `records` | QR lookup and lock variant, account list, account-owned lookup, insert/seal, guarded image hash update |
| `CoCreationRepository` | `co_creations`, `co_creation_comments` | QR lookup and lock variant, effective comment list/check with internal `source_position`, insert/delete/finalize transitions |
| `OrderRepository` | `orders` | ID/order-number lookups and lock variants, account list, `insert` |
| `PaymentRepository` | `payment_transactions`, `payment_events` | provider transaction lookup, merchant order lookup, order event list, `insertTransaction`, `appendEvent` |
| `ProofRepository` | `record_proofs`, `proof_attempts` | record/operation lookup and locks, manifest/submission/failure transitions, attempt append/recovery/completion |
| `ArchiveRepository` | `record_archives` | record lookup and lock, ready metadata upsert, sanitized preparation failure |
| `OutboxRepository` | `outbox_jobs` | idempotent enqueue, bounded skip-locked claim, stale recovery, success/retry/failure transitions |
| `AuditRepository` | `audit_events` | immutable `append` |

The following contract areas remain deliberately deferred: profile/status
mutation, remaining QR batch commands, order and payment state transitions,
proof callback/query transitions, certificate persistence, archive rebuild/version
queries, and `Operator`, `QualityCheck`, `Product`, and `Content` repositories.
They must be implemented from confirmed service use cases rather than generated
as generic CRUD.

`recordProofJobHandler.js` now owns the isolated PostgreSQL proof preparation
and submission state machine. It uses short transactions for durable state and
attempt history, executes injected storage/provider work outside transactions,
preserves imported legacy proof evidence, and is not connected to application
startup or a production worker loop.

## 5. Row mapping

Each query explicitly selects a whitelist of columns. Mappers construct a new frozen domain record and discard any unlisted database columns. JSONB values are cloned before return so callers do not receive the raw row's mutable object reference.

The current domain records retain established snake-case field names to minimize later service adapter churn. They are internal records, not public API DTOs. Public DTO mapping must continue to remove account IDs, identity credentials, addresses, provider metadata, and other internal fields as required by each API.

Mappers do not generate IDs or timestamps, repair missing fields, or silently normalize impossible database states.

## 6. SQL and errors

SQL identifiers come only from fixed repository definitions. All caller-controlled values are passed through PostgreSQL placeholders. Account-owned record and order queries use `account_id` directly and never query phone or OpenID. List queries have an explicit maximum of 100 rows.

Stable infrastructure errors currently include:

- `REPOSITORY_TRANSACTION_CONTEXT_REQUIRED`
- `REPOSITORY_LIMIT_INVALID`
- `REPOSITORY_NON_UNIQUE_RESULT`
- `REPOSITORY_INSERT_RESULT_INVALID`
- `REPOSITORY_UNIQUE_CONFLICT`
- `REPOSITORY_FOREIGN_KEY_CONFLICT`
- `REPOSITORY_CHECK_CONFLICT`
- `REPOSITORY_DATABASE_UNAVAILABLE`
- `REPOSITORY_QUERY_FAILED`

Identity lookup anomalies retain the domain-specific `DUPLICATE_PHONE_IDENTITY` and `DUPLICATE_OPENID_IDENTITY` codes. Insert-time unique constraint failures remain `REPOSITORY_UNIQUE_CONFLICT` because the sanitized query context does not expose constraint names; a service must not guess which unique rule failed. Raw SQL, parameters, PostgreSQL details, and provider messages are not used as repository error messages.

Repositories do not choose HTTP status codes. That mapping belongs to future service and route integration.

## 7. Future service transaction boundaries

The following operations must use one service-owned transaction and one shared `TransactionContext`:

1. Account creation plus identity creation.
2. Miniapp phone account entry and safe temporary identity/account disposal.
3. QR activation plus sealed record creation and durable job enqueue.
4. Co-creation start, comment mutation, and finalize flows.
5. Order creation from server-read product state.
6. Payment event idempotency plus payment/order state transition.
7. Proof state and attempt progression.
8. Bounded QR batch row creation.

External HTTP, chain, OSS, SMS, and payment-provider calls must remain outside database lock windows.

## 8. Test boundary

Phase 2C-1 tests verify:

- transaction-context injection;
- parameter placeholders and parameter order;
- explicit row mapping;
- unique identity fail-closed behavior;
- explicit row-lock SQL;
- account-only ownership queries;
- bounded list limits;
- stable constraint and unknown-error mapping;
- absence of connection ownership, transaction control, automatic upsert, and runtime environment reads.

These mock tests do not prove every repository method against PostgreSQL 15+ or a migrated dataset. Phase 2B-2.5 validated migration/import infrastructure, and Phase 2C-2B-2 validated the public QR read subset against PostgreSQL 15.18. The remaining repositories still require chain-specific integration tests before runtime use.

Phase 2C-2B-7 additionally validates the public comment path against a
disposable PostgreSQL 15.18 database. `CoCreationRepository` reads effective
comments in `source_position ASC` order. `PublicQrReadAdapter` applies the
public timestamp-descending/source-position-ascending contract and excludes
the internal position from its DTO.

## 9. Next gate

Do not begin shadow reads from this implementation alone. Before any business integration:

1. Resolve the two public QR data-model gaps recorded in `public-qr-read-adapter-v1.md` before shadowing that chain.
2. Run each selected repository chain against an isolated PostgreSQL 15+ schema created by `001_init_schema.sql`.
3. Review query plans and indexes for account record lists, account order lists, QR key lookup, identity lookup, and payment callback lookup.
4. Review repository methods against the service transaction catalog before adding further service adapters.
