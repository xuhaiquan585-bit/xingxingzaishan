# Repository Contracts v1

## 1. Rules

- Routes call domain services, not repositories.
- Domain services own transaction start, commit, and rollback through `UnitOfWork`.
- Repositories accept a `TransactionContext` for cross-domain operations and never commit it themselves.
- Repository results are domain records, not raw PostgreSQL rows and not public API DTOs.
- Public DTO mappers remove internal account IDs, identity fields, and provider metadata as required by current behavior.
- Repository methods use stable domain error codes and never leak SQL messages.
- Locking methods have explicit `ForUpdate` semantics and are called only inside a transaction.
- External network or file operations do not run while database locks are held.

Conceptual infrastructure contracts:

| Component | Responsibility |
|---|---|
| `DatabaseConnection` | Pool lifecycle, health check, statement timeout, TLS configuration |
| `TransactionContext` | Bound database client and transaction identity |
| `UnitOfWork` | Begin, execute callback, commit, rollback, translate transaction errors |
| Row mappers | Database row to domain object |
| DTO mappers | Domain object to existing API response shape |

## 2. Repository method template

Each future implementation must document:

- Input shape and normalization.
- Return object or `null` behavior.
- Stable domain errors.
- Required transaction and row locks.
- Idempotency rule.
- Index used by the query.
- Sensitive fields returned.
- Current `dbService` function being replaced.

## 3. Principal repositories

### `AccountRepository`

Queries: `findById`, `findByIdForUpdate`, `exists`, `listIdentityReferences`. Writes: `insert`, `updateProfile`, `updateStatus`, `deleteDisposableAccount`. Deletion requires an already-locked account and a service-level proof that no identity or business reference exists.

### `IdentityRepository`

`users` rows are login identities, not accounts.

Queries: `findById`, `findByIdForUpdate`, `findUniqueByPhone`, `findUniqueByPhoneForUpdate`, `findUniqueByOpenid`, `findUniqueByOpenidForUpdate`, `listByAccountId`, `countByAccountId`, `findReferenceSummary`. Writes: `insert`, `updatePhone`, `updateMiniappIdentity`, `moveOpenidToIdentity`, `deleteDisposableIdentity`.

Unique lookups return `null` or one row. Multiple matches are translated to `DUPLICATE_PHONE_IDENTITY` or `DUPLICATE_OPENID_IDENTITY`, never reduced to the first row.

### `OperatorRepository`

Queries: `findEnabledByUsername`, `findById`, `listByRole`. Writes: `insert`, `setEnabled`, `changePasswordHash`. Password hashes are write-only outside authentication service results.

## 4. QR and record repositories

### `QrRepository`

Queries: `findById`, `findByAccessToken`, `findByKey`, lock variants, batch/status lists, dashboard counts. Writes: `insertBatch`, `updateLifecycle`, `setHidden`, `assignBatch`, `updateQrImage`. `findByKey` performs exact ID/token resolution without exposing access tokens in public DTOs.

### `RecordRepository`

Queries: `findByQrId`, `findByQrIdForUpdate`, `listByAccountId`, `findOwnedByAccountId`, integrity lookup by image key/hash. Writes: `insertDraft`, `insertSealed`, `sealExisting`, `updateArchiveProjection`. Ownership queries use account ID only and do not fall back to phone/OpenID.

### `CoCreationRepository`

Queries: `findByQrId`, `findByQrIdForUpdate`, `listEffectiveComments`,
`hasEffectiveComment`. Writes: `insert`, `finalize`, `insertComment`,
`softDeleteComment`. Comment insertion relies on the database partial unique
constraint to enforce one effective comment per account. Comment rows expose
the internal `source_position`; the repository returns effective comments in
stable source order and leaves the final public
`created_at DESC, source_position ASC` presentation order to the application
adapter.

### `QualityCheckRepository`

Queries: recent events, per-QR history, daily statistics. Writes: append immutable check event. The latest check result is queried or exposed through a view, not maintained as an independent mutable source.

## 5. Catalog and commerce repositories

### `ProductRepository`

Queries: `findPublishedById`, `findById`, `listPublished`, `listAdmin`, `listByScene`. Writes: `insert`, `update`, `replaceImages`, `replaceSceneTags`. Order creation never reads price or stock from a client payload.

### `OrderRepository`

Queries: `findById`, `findByIdForUpdate`, `findByOrderNo`, `findByOrderNoForUpdate`, `listByAccountId`, admin status lists. Writes: `insert`, `cancelIfPending`, `markPaid`, `markShipped`, `markCompleted`, refund status transitions. Each state method includes the expected current state in its update condition.

### `PaymentRepository`

Queries: `findByProviderTransactionId`, `findByMerchantOrderNo`, event history. Writes: `insertTransactionOnce`, `appendEvent`, `markSucceeded`, `markFailed`. Provider transaction and payload hash constraints provide callback idempotency.

## 6. Proof, archive, content, and operations repositories

### `ProofRepository`

Queries: `findByRecordId`, `findByOperationId`, `findForUpdate`, retry candidates. Writes: `insertPending`, `markManifestReady`, `markSubmitting`, `markSubmitted`, `markConfirmed`, `markFailed`, `appendAttempt`. State transitions include expected previous states.

### `ArchiveRepository`

Queries: `findByRecordId`. Writes: `upsertState`, `markReady`, `markFailed`. OSS writes occur outside the transaction; repository calls persist only durable metadata.

### `ContentRepository`

Queries: `getMiniappContent`. Writes: `updateMiniappContent`. The public mapper strips updater metadata.

### `AuditRepository`

Writes append immutable, sanitized events. Audit failure policy is defined by operation sensitivity; audit writes do not contain full identity, address, token, user text, image URL, or provider payload.

### `OutboxRepository`

Writes: `enqueueOnce`. Worker queries: `claimAvailable`, `markSucceeded`, `reschedule`, `markFailed`. Claiming uses row locks with skip-locked behavior and a stable idempotency key.

## 7. Service transaction catalog

### Account creation

Lock unique identity candidates; insert account; insert identity; commit. Duplicate phone/OpenID becomes a controlled conflict.

### Miniapp phone account entry

Lock current identity, target phone identity, and both accounts in stable key order. Revalidate uniqueness and all business references. Update target identity/OpenID, delete only a proven disposable temporary identity/account, and commit. No records, orders, or co-creation data move.

### Direct QR activation

Lock QR; require `unactivated`; insert sealed record from server-authenticated account; update QR to `activated`; enqueue proof/archive jobs; commit.

### Start co-creation

Lock QR; require `unactivated`; insert unsealed record; insert active co-creation; update QR to `co_creating`; commit.

### Add/delete comment

Lock or constrain the co-creation; verify active state and server-authenticated account; insert or soft-delete comment; commit. Duplicate effective participation is resolved by the partial unique constraint.

### Finalize co-creation

Lock QR, record, and co-creation; require caller account equals stored owner account; seal existing record; finalize co-creation; update QR to `activated`; enqueue proof/archive jobs; commit.

### Create order

Lock published product when stock is enforced; compute amount server-side; create immutable product snapshot and pending order; decrement/reserve stock if adopted; commit.

### Payment callback

Verify and decrypt the callback before the transaction. Inside the transaction, lock order, insert callback event once, validate merchant identity/amount/state, update payment transaction and order idempotently, and commit. Duplicate successful callbacks return success without repeating state changes.

### Proof progression

Short transactions create or transition proof state and enqueue/complete attempts. Chain network calls happen outside transactions using operation ID idempotency.

### QR batch generation

Create batch/QR rows in bounded transactions. QR image generation and OSS upload use outbox jobs. Each result updates its QR row in a separate short transaction; failed assets are retryable.

## 8. Current access replacement map

| Current access | Replacement |
|---|---|
| Authentication middleware and user/miniapp routes | Account/Identity services and repositories |
| QR, user record, miniapp record routes | QR/Record/CoCreation services and repositories |
| Admin/QC routes | Operator, QR batch, product, order, QC repositories |
| Payment route | Payment service transaction plus Order/Payment repositories |
| `chainProofService` | Proof service, Proof/Outbox repositories |
| `archiveService` | Archive worker, Archive/Outbox repositories |
| Account/business migration services | One-time importer and validation modules |
| OSS migrate/recovery scripts | Record repository queries or PostgreSQL restore/export tooling |
| `auditService` file append | Audit repository |

Legacy JSON write functions are not wrapped inside repositories. They are retired after cutover.
