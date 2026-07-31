# PostgreSQL Import Source Inventory v1

## Scope and evidence

This inventory is the Phase 2B-1 source contract. It was derived from `dbService.js`, explicit schema migration logic, service write paths, and test fixtures. Production `db.json` was not read.

Unknown top-level or entity fields are blocking. `content_pages` and `banners` are the only opaque legacy roots: their complete objects are classified for external archival and are not silently promoted into PostgreSQL business tables.

## Root inventory

| JSON source | PostgreSQL target/disposition | Notes |
|---|---|---|
| `meta` | sequences and import metadata | Counters are validated, not inserted as business rows |
| `accounts[]` | `accounts` | Stable account IDs are preserved |
| `users[]` | `users` | Login identities; ownership remains on accounts |
| `admins[]` | `operators` | Existing password hashes only |
| `batches[]` | `qr_batches` | Creator text remains a snapshot unless an operator link is proven |
| `qr_codes[]` | split matrix below | No standalone JSON records collection exists |
| `quality_check_logs[]` | `quality_check_logs` | Embedded QR summary is reconciled separately |
| `products[]` | `products`, `product_images`, `product_scene_tags` | Child arrays are normalized; child `created_at` inherits the source product timestamp |
| `orders[]` | `orders` | OpenID and phone remain snapshots |
| `payment_logs[]` | `payment_transactions`, `payment_events`, or `audit_events` | Order-linked events share one transaction per provider/order; rejected unlinked callbacks become audit events whose SQL `metadata` contains sanitized flags/hashes only |
| `miniapp_content` | singleton `miniapp_content` | Slides/cards remain JSONB snapshots |
| `content_pages[]` | external read-only archive | No current runtime target |
| `banners[]` | external read-only archive | No current runtime target |

## QR split inventory

| Source path | Target | Rule |
|---|---|---|
| `qr_codes[].id` | `qr_codes.id` | Preserve exact stable ID |
| issue/activation/hidden/batch/print fields | `qr_codes` | `activation_status` becomes `lifecycle_status` |
| QR image/token fields | `qr_codes` | URL is a compatibility snapshot; token remains unique |
| `content` | `records.content` | Record text source of truth |
| `image_url` | `records.image_url_snapshot` | Compatibility snapshot |
| `image_object_key` | `records.image_object_key` | Preferred object locator |
| `image_sha256` | `records.image_sha256` | Lowercase SHA-256 required when present |
| `phone` | `records.phone_snapshot` | Never ownership |
| `account_id` | `records.account_id` | Account ownership FK |
| `activated_at` | `records.sealed_at` | Null for active co-creation |
| brand disclosure fields | `records` | Preserve immutable presentation snapshot |
| `co_creation_owner_phone` | `co_creations.owner_phone_snapshot` | Never ownership |
| `co_creation_owner_account_id` | `co_creations.owner_account_id` | Owner authority FK |
| `co_creation_started_at` | `co_creations.started_at` | Stable start time |
| `co_creation_comments[]` | `co_creation_comments` | Preserve local legacy comment ID, deleted rows, and zero-based array index as `source_position` |
| chain/proof fields | `record_proofs` | `manifest_hash` is canonical; conflicts block |
| `chain_retry_count` | `record_proofs.retry_count` | Aggregate only; no invented attempt history |
| archive fields | `record_archives` | Archive state stays independent of QR lifecycle |
| embedded `quality_check` | reconciliation input | An equivalent root log wins; synthetic history is deferred |

For each source QR, the dry-run proves this relationship:

```text
1 qr_codes row
0..1 records row
0..1 co_creations row
N co_creation_comments rows
0..1 record_proofs row in the current source model
0..1 record_archives row in the current source model
```

For each QR comment array, mapping is position-preserving:

```text
co_creation_comments[index]
  -> co_creation_comments.source_position = index
```

The importer does not sort comments before assigning this value. Deleted
comments consume and retain their original positions.

The current source stores one aggregate proof state and one aggregate archive state per QR. It does not contain proof-attempt history, so Phase 2B-1 must not invent `proof_attempts` rows.

## Entity fields

The executable allowlists live in `scripts/database/importer/mapping.js`. They cover:

- Account identity, timestamps, status, display metadata, and creation source.
- User identity fields, account relation, source, and timestamps.
- Operator ID, username, password hash, role, name, enabled flag, and optional timestamps.
- Batch scalar fields and creator snapshot.
- QR matrix fields documented in `schema-v1.md` plus `account_id`, owner account ID, image hash, and timestamps introduced by account phases.
- Comment ID, phone/account identity, author, content, status, creation/deletion timestamps.
- Product scalar fields plus image and scene-tag arrays.
- Order ownership, product snapshot, integer-cent amounts, status, payment snapshot, delivery PII, logistics, and timestamps.
- Payment log identity, order relation, method/status/amount/transaction, raw payload, error presence, and timestamp.
- Miniapp content scalar fields, `home_slides`, and `scene_cards` with nested allowlists.

Any new field requires an explicit inventory and mapping decision before a source can be reported READY.

## Sensitive-data handling

- Full phone, OpenID, UnionID, address, user content, image URL/object key, password hash, payment payload, and provider error text may exist only in the in-memory plan.
- The plan is never printed, logged, serialized, or written in Phase 2B-1.
- Reports use entity type, field name, stable reference hash prefix, category, count, and blocking flag only.
- Tests use artificial values and must not snapshot or dump a complete plan.

## Evidence locations

- Root shape and deterministic migration normalization: `src/server/services/dbService.js` (`createInitialDatabaseSnapshot`, `migrateDatabaseSnapshot`).
- QR record/co-creation/comment writes: `activateQRCodeOnce`, `startCoCreationOnce`, `addCoCreationCommentByKey`, `finalizeCoCreationByKey`.
- Product/order/payment writes: `normalizeProductInput`, `createMiniappOrder`, payment log functions.
- Miniapp content shape: `normalizeMiniappContent`, `normalizeHomeSlides`, `normalizeSceneCards`.
- Target columns and constraints: `database/migrations/001_init_schema.sql`.
