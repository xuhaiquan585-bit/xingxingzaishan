# PostgreSQL Service Migration Map v1

## 1. Purpose And Boundary

This document maps the current JSON-backed business behavior to the future
PostgreSQL application-service and repository structure. It is a migration map,
not an implementation.

Phase 2C-2A does not:

- create an application service or service adapter;
- replace any `dbService` call;
- change QR, authentication, order, payment, proof, or archive behavior;
- add feature flags, shadow reads, dual writes, or database routing;
- connect to PostgreSQL or read production data.

Current runtime facts:

- `src/server/services/dbService.js` and the JSON database remain the only
  runtime business-data source.
- PostgreSQL repositories are infrastructure only and receive no traffic.
- Phase 2B-2.5 PostgreSQL staging execution completed against disposable local
  PostgreSQL 15.18 databases.
- All proposed methods and transactions below are design contracts only.

## 2. Inventory Method

The inventory covers direct imports, destructured imports, lazy imports,
aliases, wrapper services, string collection access, raw JSON file access, and
generic read/write helpers under `src/server`, `scripts`, `src/admin`, `src/qc`,
and tests.

Inventory result:

- `dbService` exports: 68
- exports with a runtime caller outside `dbService`: 56
- exports without an outside runtime caller: 12
- direct core JSON readers/writers outside `dbService`: 3 services/scripts
- separate append-only audit store: 1 service

The 12 exports without an outside runtime caller are not all dead code.
`activateQRCodeOnce()` is used internally by `activateQRByKey()`, and
`findUserByOpenid()` supports legacy internal lookup helpers. The remaining
legacy methods must stay classified as compatibility or pending removal until
call-site and release-history review is complete.

No unclassified dynamic collection dispatcher was found in the active runtime.
Where scripts resolve `DB_FILE` dynamically, they are listed explicitly below.

## 3. Current JSON Collections

| JSON source | Current role | PostgreSQL destination |
|---|---|---|
| `accounts` | Stable business account | `app.accounts` |
| `users` | Phone/OpenID login identities | `app.users` |
| `admins` | Admin and operator identities | `app.operators` |
| `batches` | QR production batches | `app.qr_batches` |
| `qr_codes` | QR identity plus record, co-creation, proof, and archive fields | `app.qr_codes`, `app.records`, `app.co_creations`, `app.co_creation_comments`, `app.record_proofs`, `app.record_archives` |
| `quality_check_logs` | Batch and QR quality events | `app.quality_check_logs` |
| `products` | Product catalog with embedded images/tags | `app.products`, `app.product_images`, `app.product_scene_tags` |
| `orders` | Order aggregate | `app.orders` |
| `payment_logs` | Payment attempts, callbacks, and events | `app.payment_transactions`, `app.payment_events` |
| `content_pages` | H5/admin content | archive or a later content repository decision |
| `banners` | Legacy/configured banners | archive or a later content repository decision |
| `miniapp_content` | Miniapp home/about content | `app.miniapp_content` |

The current database has no independent `records` collection. A saved record
is represented by fields embedded in a `qr_codes` object. The importer mapping,
repository design, and service transactions must preserve that fact while
normalizing it into separate PostgreSQL tables.

## 4. Complete dbService Export Map

### 4.1 Database Lifecycle And Snapshot

| Current method | Current callers/use | JSON source | Future owner |
|---|---|---|---|
| `initializeDB` | `app.js` startup | all required collections | migration runner/startup schema gate, not a repository |
| `migrateDatabaseSnapshot` | explicit migration/test path | full snapshot | one-time importer/migration tooling |
| `getDatabaseSnapshot` | archive and operational tools | full snapshot | backup/export service, outside repositories |
| `getDatabaseSnapshotWithHash` | recovery tooling | full snapshot | backup/recovery service |
| `writeDatabaseSnapshot` | guarded recovery | full snapshot | PostgreSQL restore procedure, never normal runtime repository code |

### 4.2 Accounts And Identities

| Current method | Current callers/use | JSON source | Future owner |
|---|---|---|---|
| `createOrGetUser` | H5 phone login | `accounts`, `users` | account-entry application service + `AccountRepository` + `IdentityRepository` |
| `findUserById` | no outside runtime caller | `users` | `IdentityRepository.findById` if retained |
| `getAuthenticatedUserById` | H5 session middleware | `users`, `accounts` | authentication query service |
| `getAuthenticatedMiniappUser` | miniapp auth middleware | `users`, `accounts` | authentication query service |
| `findUserByOpenid` | internal legacy helpers | `users` | `IdentityRepository.findUniqueByOpenid` |
| `createOrGetMiniappUser` | miniapp login | `accounts`, `users` | miniapp account-entry service |
| `bindMiniappUserPhone` | WeChat and SMS phone entry | `accounts`, `users`, business-reference scan | miniapp phone-entry application service and one transaction |

### 4.3 QR, Records, Co-creation, Proof State

| Current method | Current callers/use | JSON source | Future owner |
|---|---|---|---|
| `getQRCode` | public QR, NFT, proof/archive services | `qr_codes` | `QrRepository.findById` plus record/proof projection |
| `findRecordByChainOperationId` | chain callback/service | embedded proof fields | `ProofRepository.findByOperationId` + `RecordRepository` |
| `updateRecordChainProof` | proof/archive services | embedded proof/archive fields | proof/archive application service |
| `findQRByToken` | H5 QR lookup | `qr_codes` | `QrRepository.findByToken` |
| `findQRByKey` | H5/miniapp public lookup | `qr_codes` | QR public-query service |
| `getSampleUnactivated` | sample/debug route | `qr_codes` | operational query or removal decision |
| `activateQRCodeOnce` | internal direct-save helper | `qr_codes` | QR activation application service transaction |
| `activateQRByKey` | H5/miniapp direct save | `qr_codes` | QR activation application service transaction |
| `startCoCreationByKey` | H5/miniapp start co-creation | `qr_codes` | co-creation application service transaction |
| `addCoCreationCommentByKey` | H5/miniapp comment | embedded comments | co-creation comment service transaction |
| `deleteCoCreationCommentByKey` | owner soft delete | embedded comments | co-creation owner service transaction |
| `finalizeCoCreationByKey` | owner finalize | embedded record/co-creation | co-creation finalize service transaction |

### 4.4 Personal Record Queries

| Current method | Current callers/use | JSON source | Future owner |
|---|---|---|---|
| `listActivatedRecordsByPhone` | no outside runtime caller; legacy | `qr_codes` | do not port as ownership query |
| `listActivatedRecordsByAccountId` | H5/miniapp personal list | `qr_codes` | record archive query service using record and co-creation repositories |
| `listActivatedRecordsByMiniappOpenid` | no outside runtime caller; legacy | `users`, `qr_codes` | do not port as ownership query |
| `getActivatedRecordByPhoneAndId` | no outside runtime caller; legacy | `qr_codes` | do not port as ownership query |
| `getActivatedRecordByAccountIdAndId` | H5/miniapp detail | `qr_codes` | `RecordRepository.findOwnedById` query service |
| `getActivatedRecordByMiniappOpenidAndId` | no outside runtime caller; legacy | `users`, `qr_codes` | do not port as ownership query |

### 4.5 Products And Orders

| Current method | Current callers/use | JSON source | Future owner |
|---|---|---|---|
| `createProduct` | admin | `products` | `ProductRepository` |
| `updateProduct` | admin | `products` | product application service |
| `listProducts` | admin/miniapp | `products` | `ProductRepository` |
| `getProduct` | admin/miniapp/order creation | `products` | `ProductRepository.findById` |
| `createMiniappOrder` | miniapp | `products`, `orders` | order creation application service transaction |
| `listMiniappOrders` | no outside runtime caller; legacy OpenID ownership | `orders` | do not port as ownership query |
| `listMiniappOrdersByAccountId` | miniapp | `orders` | `OrderRepository.listByAccountId` |
| `getMiniappOrder` | no outside runtime caller; legacy OpenID ownership | `orders` | do not port as ownership query |
| `getMiniappOrderByAccountId` | miniapp | `orders` | `OrderRepository.findOwnedById` |
| `getOrderByOrderNo` | payment callback | `orders` | `OrderRepository.findByOrderNo` |
| `cancelMiniappOrder` | no outside runtime caller; legacy OpenID ownership | `orders` | do not port as ownership command |
| `cancelMiniappOrderByAccountId` | miniapp | `orders` | order command service transaction |
| `payMiniappOrderMock` | no outside runtime caller; legacy OpenID ownership | `orders`, `payment_logs` | do not port as ownership command |
| `payMiniappOrderMockByAccountId` | miniapp test payment | `orders`, `payment_logs` | payment application service transaction |
| `appendPaymentLog` | payment route | `payment_logs` | `PaymentRepository.insertEvent` |
| `markOrderPaidByOrderNo` | payment callback | `orders`, `payment_logs` | payment callback service transaction |
| `listOrders` | admin | `orders` | admin order query service |
| `updateOrderShipment` | admin | `orders` | shipment application service transaction |

### 4.6 Admin, Batches, QC, Content

| Current method | Current callers/use | JSON source | Future owner |
|---|---|---|---|
| `findAdmin` | admin authentication | `admins` | `OperatorRepository` |
| `listOperators` | admin | `admins` | `OperatorRepository` |
| `createOperator` | admin | `admins` | operator application service |
| `setOperatorEnabled` | admin | `admins` | operator application service |
| `changeOperatorPassword` | admin | `admins` | operator credential service |
| `getDashboardStats` | admin | multiple collections | reporting query service/read model |
| `listQRRecords` | admin | `qr_codes`, products/proofs | admin record query service |
| `getMiniappContent` | miniapp | `miniapp_content` | `ContentRepository` |
| `updateMiniappContent` | admin | `miniapp_content` | content application service |
| `generateQRCodes` | admin | `qr_codes`, filesystem images | QR batch-generation service + outbox/assets |
| `setQRHiddenStatus` | admin | `qr_codes` | QR moderation service |
| `setQRHiddenStatusBatch` | admin | `qr_codes` | QR moderation service transaction |
| `createBatch` | admin | `batches` | `QrBatchRepository` |
| `listBatches` | admin/H5 | `batches` | `QrBatchRepository` |
| `assignBatchToQRCodes` | admin | `batches`, `qr_codes` | QR batch assignment service transaction |
| `getBatchDetail` | admin | `batches`, `qr_codes` | batch query service |
| `exportBatchCSV` | admin | `batches`, `qr_codes` | batch export query service |
| `runQualityCheck` | QC | `qr_codes`, `quality_check_logs` | quality-check service transaction |
| `getQualityCheckLogs` | QC | `quality_check_logs` | `QualityCheckRepository` |
| `getQualityCheckStats` | QC | `quality_check_logs` | QC reporting query service |

## 5. Call-Site And Route Map

| Business entry | Current chain | Future chain |
|---|---|---|
| H5 login | `routes/user.js` -> `createOrGetUser` | route -> H5 account-entry service -> account/identity repositories |
| H5 session verification | `userSession` middleware -> `getAuthenticatedUserById` | middleware -> authentication query service -> identity/account repositories |
| Miniapp login | `routes/miniapp.js` -> `createOrGetMiniappUser` | route -> miniapp account-entry service -> account/identity repositories |
| Miniapp token verification | `miniappAuth` -> `getAuthenticatedMiniappUser` | middleware -> authentication query service |
| Miniapp phone entry | WeChat/SMS routes -> `bindMiniappUserPhone` | route -> verified-phone entry service -> one account/identity transaction |
| Public QR view | H5/miniapp QR GET -> `findQRByKey`/`getQRCode` | route -> public QR query service -> QR/record/co-creation/proof repositories |
| Direct record save | QR/miniapp POST record -> validation/content safety -> `activateQRByKey` | route -> activation service -> one database transaction -> outbox |
| Start co-creation | QR/miniapp POST record in co-create mode -> `startCoCreationByKey` | route -> co-creation start service -> one database transaction |
| Add comment | QR/miniapp comments -> `addCoCreationCommentByKey` | route -> comment service -> one database transaction |
| Delete comment | owner route -> `deleteCoCreationCommentByKey` | route -> owner comment service -> one database transaction |
| Finalize co-creation | owner route -> `finalizeCoCreationByKey` | route -> finalize service -> one database transaction -> outbox |
| Personal records | user/miniapp routes -> account-ID record methods | route -> personal record query service |
| Product browsing | miniapp/admin -> product methods | route -> product query/application service |
| Order creation | miniapp route -> `createMiniappOrder` | route -> order service -> product/order repositories in one transaction |
| User order operations | miniapp routes -> account-ID order methods | route -> order query/command service |
| Payment callback | payment route -> verify/decrypt -> order lookup -> mark/log | route -> callback service -> order/payment repositories in one transaction |
| Proof submission/callback | proof/chain service -> QR/proof update methods | route/job -> proof service -> proof/record/outbox repositories |
| Archive | archive service -> snapshot/record helpers and OSS/local files | archive job -> archive repository + object storage adapter |
| Admin/QC | admin/QC routes -> broad `dbService` methods | route -> focused application/query services and missing repositories |

Application services are deliberately not created in this phase.

## 6. Dynamic And Direct Data Access

### 6.1 Core JSON File Access Outside dbService

| Location | Access | Future treatment |
|---|---|---|
| `src/server/services/accountMigrationService.js` | reads and atomically rewrites explicit `DB_FILE` snapshots | retire after PostgreSQL identity migration; replace with audited SQL migration tooling |
| `src/server/services/businessAccountAuditService.js` | reads snapshots and can perform guarded backfill writes | preserve report logic for migration validation, remove runtime JSON write role after cutover |
| `scripts/migrate-local-to-oss.js` | reads and rewrites explicit JSON source while migrating object references | convert to object-storage migration against exported/staging data; never point at live PostgreSQL tables directly |
| `scripts/recover-from-oss.js` | calls guarded snapshot APIs | replace with PostgreSQL backup/restore runbook, not repositories |

### 6.2 Related Stores That Are Not Core DB Writes

| Location | Store | Treatment |
|---|---|---|
| `src/server/services/auditService.js` | append-only JSONL audit file | migrate new events to `AuditRepository`; archive historical file separately |
| archive/storage services | OSS or local object files | keep binary objects in OSS; PostgreSQL stores object key, hash, status, and metadata only |
| importer scripts | explicitly supplied snapshot fixture/export | one-time migration tooling; no runtime dependency |

No route should import a PostgreSQL repository directly. Raw JSON and raw SQL
access remain infrastructure concerns and cannot be used as an adapter shortcut.

## 7. Target Responsibility Model

```text
route / middleware
        |
        v
application service or query service
        |
        +-- business rules, authorization, lifecycle decisions
        +-- TransactionContext boundary
        +-- stable domain/application errors
        |
        v
repository
        |
        +-- parameterized SQL
        +-- row locking requested by the service
        +-- persistence error translation
        |
        v
PostgreSQL
```

Rules:

- repositories do not commit cross-domain transactions;
- repositories do not decide lifecycle or authorization policy;
- repositories do not expose raw rows or SQL to routes;
- application services do not accept account ownership from client input;
- `users` stores login identities and does not represent the business owner;
  business ownership always points to `accounts`;
- external network calls do not run while row locks are held; use durable state
  plus `outbox_jobs` where asynchronous work follows a business commit.

## 8. Repository Coverage And Gaps

### 8.1 Implemented Infrastructure Contracts

| Repository | Existing capability | Required service use |
|---|---|---|
| `AccountRepository` | find, lock, exists, insert | account-entry and identity transactions |
| `IdentityRepository` | find/lock by ID, phone, OpenID; list/count; insert | authentication and phone-entry transactions |
| `QrRepository` | find/lock by ID/key/token; conditional lifecycle update | public QR reads and lifecycle commands |
| `QrBatchRepository` | public projection lookup by ID | public QR batch enrichment |
| `RecordRepository` | find by QR; owned reads; insert sealed | direct activation and record queries |
| `CoCreationRepository` | find/lock; effective comments; insert creation/comment | co-creation commands |
| `OrderRepository` | find/lock; list by account; insert | order commands and queries |
| `PaymentRepository` | transaction/event reads and inserts | payment attempts and callbacks |
| `ProofRepository` | find/lock and insert pending/attempt | proof state machine |
| `AuditRepository` | append | security and business audit events |

### 8.2 Required Before Any Business Adapter

| Gap | Needed operations |
|---|---|
| `OperatorRepository` | credential lookup, create, enable/disable, password update |
| `ProductRepository` | published product reads, admin writes, images, scene tags |
| Remaining QR batch commands/queries | create/list/lock, assignment, export projection |
| `QualityCheckRepository` | append result, list and aggregate |
| `ContentRepository` | miniapp content read/update |
| `ArchiveRepository` | record archive create/status/version queries |
| `OutboxRepository` | enqueue, lease, retry, complete/fail |
| Record commands | insert draft, seal existing, guarded status update |
| Co-creation commands | soft-delete comment, finalize/close, guarded owner operations |
| Order commands | conditional cancel/pay/ship state transitions |
| Payment commands | idempotent transaction/event state transitions |
| Proof commands | conditional submit/confirm/fail and retry attempts |
| Account cleanup support | reference summary, safe identity move/delete, orphan prevention |

The gaps are recorded only. They must not be implemented until staging SQL and
the chosen first chain have been accepted.

## 9. QR Lifecycle Migration Design

### 9.1 Business Meaning

`lifecycle_status` represents only the QR business lifecycle:

```text
unactivated -> co_creating -> activated
unactivated ----------------> activated
```

It does not represent proof, payment, archive, upload, or chain state. States
such as `activated_pending_chain` must not be added to this column.

Scanning or opening a page does not activate, bind, or reserve a QR. The first
successful direct save or co-creation start takes its initial write right.

### 9.2 Public Read

```text
QrPublicQueryService
  -> QrRepository.findByToken/findById
  -> load Record/CoCreation/Comment/Proof projection as needed
  -> preserve hidden/missing and public-visibility response semantics
```

This path is read-only and does not lock or change lifecycle state.

### 9.3 Direct Save Transaction

```text
transaction
  QR = QrRepository.findByTokenForUpdate()
  require QR.lifecycle_status == unactivated
  require caller account from authenticated server context
  RecordRepository.insertSealed(qr_id UNIQUE, account_id, snapshots, content)
  QrRepository.updateLifecycleStatus(unactivated -> activated)
  OutboxRepository.enqueue(proof/archive work)
commit
```

Protection is three-layered:

1. the application service decides whether initial writing is allowed;
2. `SELECT ... FOR UPDATE` serializes competitors for the same QR;
3. `records.qr_id` uniqueness and lifecycle `CHECK`/conditional update prevent
   a second record or invalid stored status.

The repository must not contain a rule such as “if first scan then create.”

### 9.4 Start Co-creation Transaction

```text
transaction
  QR = QrRepository.findByTokenForUpdate()
  require QR.lifecycle_status == unactivated
  RecordRepository.insertDraft(qr_id UNIQUE, owner account, initial content)
  CoCreationRepository.insert(owner_account_id, qr_id UNIQUE)
  QrRepository.updateLifecycleStatus(unactivated -> co_creating)
commit
```

### 9.5 Comment Transaction

```text
transaction
  lock QR/co-creation
  require lifecycle_status == co_creating
  check only effective comment.account_id for duplicate participation
  insert comment with authenticated account_id and phone snapshot
commit
```

Deleted comments do not block participation. A historical comment without
`account_id` is not reclaimed by phone.

### 9.6 Finalize Transaction

```text
transaction
  lock QR, record, and co-creation
  require lifecycle_status == co_creating
  require caller.account_id == co_creation.owner_account_id
  seal the existing record using the stored owner_account_id
  close/finalize co-creation
  update QR co_creating -> activated
  enqueue proof/archive work
commit
```

Finalization does not create a second record, re-resolve the owner by phone, or
use a client-supplied account ID.

### 9.7 Subsequent Scans

- `activated`: public and authorized record reads only; no second record, owner
  change, reset, or overwrite.
- `co_creating`: public read remains available under the current visibility
  rules; only explicit authenticated comment/owner operations may write.
- database `CHECK` protects allowed values, while service logic and conditional
  updates protect transition direction.

### 9.8 Current JSON Risks To Preserve In Acceptance Tests

- current lifecycle and record fields share one JSON object;
- current direct activation performs read/check/write without a per-QR row lock;
- whole-file JSON writes can race with unrelated writers;
- proof/archive preparation occurs after the business write and can update
  embedded metadata separately;
- route formatters currently own public DTO and visibility rules.

PostgreSQL migration must preserve current user-visible behavior while replacing
these persistence risks with short transactions and durable follow-up jobs.

## 10. Other Critical Transaction Boundaries

### 10.1 H5 Account Entry

Lock the normalized phone identity key, reject duplicates/anomalies, create an
account and identity together when absent, or return the one valid existing
identity. Session issuance happens after commit.

### 10.2 Miniapp Login And Phone Entry

In one transaction, lock current identity, target phone identity, and involved
accounts; revalidate all mappings and business references; update the trusted
OpenID entry; remove only a proven disposable temporary identity/account.
Token issuance happens after commit. No records, orders, or co-creation data move.

### 10.3 Order Creation

Lock/read the published product, calculate price on the server, create order and
product/address snapshots atomically, and never trust a client amount. Inventory
reservation remains an explicit future business decision; it is not silently
introduced during migration.

### 10.4 Payment Callback

Verify/decrypt provider data before the transaction. In a short transaction,
lock the order/payment row, enforce provider/merchant transaction uniqueness,
validate order number and amount, append an idempotent payment event, and update
payment/order state. Duplicate callbacks return the existing result without
duplicating state transitions.

### 10.5 Proof State Update

External proof submission occurs outside the transaction. Transactions only
record pending work, operation IDs, attempts, callbacks, and conditional state
changes. `operation_id` uniqueness is the idempotency boundary.

### 10.6 QR Batch Generation

Reserve QR IDs/tokens and create the batch in a bounded database transaction.
Generate PNG/object files through outbox jobs. A failed asset must remain a
visible retryable state, not an untracked file or a rolled-back database ID reused
by another batch.

## 11. Error And Response Compatibility

Application services must map repository/constraint results to current stable
semantics. Routes continue controlling HTTP and DTO shape.

| Condition | Intended behavior |
|---|---|
| unauthenticated or current identity lacks valid account | 401 through current authentication middleware |
| requested owned object missing or lacks provable account ownership | 404 without phone/OpenID fallback |
| authenticated non-owner co-creation command | current 403/404 contract |
| duplicate/closed lifecycle action | current 409 contract |
| duplicate phone/OpenID or invalid identity mapping | stable conflict code, no raw IDs/counts |
| PostgreSQL uniqueness race | translate to the same domain conflict, not raw SQL error |
| infrastructure/unknown error | existing internal-error path, never disguised as a business 409 |

DTO construction must continue filtering `account_id`, OpenID, internal user IDs,
payment payloads, provider errors, and repository details.

## 12. Test Migration Map

| Test area | Current assertions to retain | PostgreSQL/service additions |
|---|---|---|
| public QR view | unauthenticated access, hidden/missing semantics, visibility fields | compare DTOs from JSON and PostgreSQL read models before cutover |
| personal records | account ownership, no phone/OpenID fallback, missing account field excluded/404 | repository integration tests and DTO shadow comparison |
| account entry | unique phone/OpenID, temp account cleanup, old/new token behavior | transaction race tests and real constraint-error mapping |
| direct save | only unactivated QR can save, payload account is server-derived, one record | concurrent transactions against one QR; one commit, one domain conflict |
| co-creation | account owner checks, effective-comment dedupe, finalize continuity | start/comment/finalize transaction and lock tests |
| orders | server price, account ownership, cancel/pay status | real transaction and conditional state tests |
| payment | signature/decryption, amount, idempotent callback | duplicate/out-of-order provider event integration tests |
| proof/archive | operation ID and state updates, response filtering | outbox retry, unique operation, callback idempotency tests |
| admin/QC | filters, batches, exports, status changes | repository/query integration tests before adapter work |

Existing fixtures with intentionally missing or conflicting identity data remain
anomaly fixtures. Normal fixtures should represent post-backfill account-owned
data. Tests must not preserve legacy phone/OpenID ownership by adding fallback.

## 13. Migration Priority And Gates

Code analysis supports this order:

1. **Public QR read**: read-only, no ownership mutation, but must preserve public
   visibility and embedded-to-normalized DTO composition.
2. **Personal record read**: account-ID only and read-only; requires correct
   combination of activated records and owned co-creations.
3. **Account and identity reads/entry**: security-sensitive; enables later writes
   but requires constraints, transaction tests, and token/session compatibility.
4. **Direct QR activation**: first write-right transaction and core concurrency
   boundary.
5. **Co-creation**: multi-step state machine and participant/owner permissions.
6. **Orders and payment**: financial state and provider idempotency.
7. **Proof, archive, audit, admin, and QC**: external jobs and operational views.

This is a recommendation from the dependency map, not an implementation decision.

No adapter work may begin until all applicable gates pass:

- chain-specific repository execution and query-plan verification on
  PostgreSQL 15+;
- real PostgreSQL repository integration tests for the selected read chain;
- approved DTO and error compatibility tests;
- selected chain has complete repository operations and no raw JSON side path;
- rollback and observability plan is documented;
- the first adapter scope is approved separately.

Shadow reads come only after a selected adapter exists and passes real database
integration tests. A shadow read compares sanitized DTOs and records only
redacted differences; it never performs PostgreSQL-to-JSON or JSON-to-PostgreSQL
dual writes.

## 14. Open Risks And Decisions

| Risk/decision | Impact | Required later action |
|---|---|---|
| `listActivatedRecordsByAccountId` combines activated records and active co-creations | a simple record query would drop in-progress items | define personal archive query across records and co-creations |
| public QR DTO logic lives in routes | adapter could accidentally expose normalized account fields | extract/test serializer only in the approved adapter phase |
| direct activation JSON race | concurrent saves or unrelated writes can conflict today | keep current JSON hardening until PostgreSQL write cutover; add PG lock tests |
| proof/archive metadata is embedded and updated after save | partial follow-up state is possible | introduce outbox and separate proof/archive state machine |
| payment callback spans verification, lookup, logging, and update | duplicate/out-of-order events risk inconsistent logs | design idempotent callback service transaction |
| account phone entry scans business references | incomplete reference logic could delete an identity/account unsafely | create a PostgreSQL reference-summary query and integration tests |
| repository coverage is incomplete | premature adapters would bypass abstractions | implement only the operations required by the approved first chain |
| content/admin/QC query shapes are composite | CRUD repositories alone do not replace dashboards/exports | add explicit query services/read models later |
| legacy ownership methods remain exported | accidental reuse can reintroduce phone/OpenID ownership | mark deprecated and remove only in a separate audited cleanup |
| Public QR disclosure/order model gaps remain | offline adapter comparison cannot reproduce those fields exactly | resolve the documented schema/importer decisions before shadow read |

## 15. Phase Exit Statement

Phase 2C-2A produces only this migration map. It does not create or change an
application service, adapter, repository implementation, route, middleware,
feature flag, database selector, shadow read, or production data path.

Phase 2B-2.5 is complete, and the isolated public QR read adapter has been
implemented and validated offline. Its remaining data-model gaps are recorded
in `public-qr-read-adapter-v1.md`; they must be resolved before any shadow read
or runtime integration. Other chains still require separately scoped adapters
and PostgreSQL integration validation.
