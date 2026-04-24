# Time-Off Microservice — Technical Requirements Document

**Status:** Draft v1
**Author:** Fozan Javaid

This document covers the design of a backend service that handles employee time-off requests and keeps leave balances in sync with an external HCM (Human Capital Management) system.

---

## 1. The problem

ExampleHR is where employees submit time-off requests. The actual employment data, including leave balances, lives in an HCM system like Workday or SAP. The HCM is the source of truth.

Keeping balances consistent between two systems is the hard part. A few things make it trickier than a typical cache-and-invalidate problem:

- HCM can change balances on its own. An employee might get an anniversary bonus, a yearly refresh, or a manual correction by an admin, and none of that goes through our service.
- HCM's error responses can't be fully trusted. Sometimes it will silently accept an invalid operation and still return 200 OK. We need to be defensive about this.
- We still have to give the user fast, responsive feedback. They shouldn't wait for an HCM round-trip every time they open the app.

So the job comes down to three things: manage the request lifecycle locally, write reliably to HCM, and reconcile whenever HCM's state moves out from under us.

## 2. Scope

### In scope

- Full request lifecycle: submit, approve, reject, cancel, sync with HCM, complete.
- Local balance queries per `(employee, location)`.
- Reliable, idempotent writes to HCM with retry on transient failures.
- Reconciliation against HCM's batch corpus.
- Concurrency protection when multiple requests target the same balance.
- An audit trail that survives months of operation.
- **Weekend handling (Saturday and Sunday treated as non-working).** Working-day rules vary by country (Friday–Saturday is the weekend in several Middle Eastern countries, some regions run shorter or shifted weeks). For this exercise we pick the most common pattern and document it. A future enhancement would accept a per-tenant or per-employee weekend configuration.
- **OpenAPI / Swagger documentation** exposed at `/api/docs`, generated from NestJS decorators so evaluators (and real consumers) can inspect and try endpoints without separate tooling.

### Out of scope

These are deliberate scoping calls. The service is kept intentionally minimal so the core sync problem gets full attention in the time available.

- Multiple leave types (vacation, sick, PTO, etc.). One type only for now.
- Half-days or hourly leave. Integer days only.
- Public-holiday calendars. Weekends are handled; statutory holidays are not.
- Accrual policies (balances growing over time).
- Multi-tenancy.
- Full SSO or production-grade authentication. A role matrix is documented in Section 8 but isn't wired up to a real identity provider.
- Any UI. This is a backend service.
- Notifications (email, Slack, webhooks) on state changes.
- Running as more than one instance. The design assumes a single node; the scaling path is noted in Section 9.

## 3. The challenges

These are the hard problems that shape the rest of the design. Each one is picked up in a later section.

| # | Challenge | Why it's hard | Addressed in |
|---|---|---|---|
| C1 | Keeping our service and HCM in sync | Both systems can change state; drift is silent | Section 5, Section 7 |
| C2 | HCM changes balances on its own | Anniversary bonuses and refreshes bypass us entirely | Section 7.4 |
| C3 | Concurrent requests on the same balance | Two approvals on a 10-day balance can over-deduct | Section 9 |
| C4 | HCM calls can fail or their responses can be lost | Retrying naively risks double-deducting | Section 7.2 |
| C5 | HCM sometimes accepts invalid writes silently | A 200 OK isn't proof of success | Section 7.5 |
| C6 | Requests have a non-trivial lifecycle | Many states, and cancellation behaviour depends on the current one | Section 6 |
| C7 | Reconciliation can clobber in-flight requests | A batch arriving mid-request could "correct away" a legitimate hold | Section 7.4.3 |
| C8 | Audit and explainability | Every balance change must be traceable months later | Section 5.1 |

## 4. Architecture

### 4.1 How it fits together

```
  ┌──────────────────┐       ┌─────────────────────────┐       ┌────────────────┐
  │                  │ REST  │                         │ HTTP  │                │
  │  ExampleHR UI    │──────▶│ Time-Off Microservice   │──────▶│  HCM (mock)    │
  │  (not in scope)  │       │      (this service)     │       │                │
  │                  │       │                         │       │                │
  └──────────────────┘       └──────────┬──────────────┘       └────────┬───────┘
                                        │                               │
                                        │  POST /hcm/batch-sync         │
                                        │◀──────────────────────────────┘
                                        │  (HCM pushes the corpus)
                                        ▼
                               ┌────────────────┐
                               │   SQLite       │
                               │    - ledger    │
                               │    - requests  │
                               └────────────────┘
```

### 4.2 Design decisions at a glance

A summary of the choices. Each one is explained in full and weighed against alternatives later in the document.

| Topic | Decision | Why |
|---|---|---|
| Balance storage | Append-only ledger of deltas | Clean audit trail, simple reconciliation, no destructive mutations |
| Pending request state | Kept on a separate `requests` table; ledger is only written when HCM confirms | Keeps the ledger to settled facts |
| Concurrency | In-process mutex keyed on `(employeeId, locationId)` | Good enough for a single instance; Redis is the path if we scale out |
| HCM writes | Idempotency key per operation, retry with exponential backoff | A lost response can be safely retried without double-applying |
| Batch sync direction | HCM pushes to `POST /hcm/batch-sync` | Matches the way the PDF describes it ("send the corpus") |
| Trust in HCM | Verify by transaction ID when we can; fall back to batch reconciliation | Defends against silent acceptance of bad writes |
| API style | REST, with `POST /resource/:id/action` for state transitions | Cleaner state machine, authorisation, and audit than a generic PATCH |
| API docs | OpenAPI / Swagger generated from NestJS decorators | Browsable at `/api/docs` for evaluators and consumers |
| Stack | NestJS + SQLite + TypeORM, Jest for tests | Per the assignment brief |

### 4.3 Service layers

```
  HTTP Layer
  ├── Controllers: requests, balances, HCM webhook, admin

  Application Services
  ├── RequestsService          — submit, approve, reject, cancel
  ├── BalanceService           — available and settled balance queries
  ├── ReconciliationService    — batch sync orchestration

  Domain Services
  ├── StateMachine             — valid transitions, guard rules
  ├── LedgerService            — append-only writes, balance projection
  ├── MutexRegistry            — per-key in-process locks

  Infrastructure
  ├── HcmClient                — retry, idempotency, timeouts
  ├── Repositories             — requests, ledger
  └── SQLite + TypeORM
```

---

## 5. Data model

### 5.1 Event-sourced ledger

Balance is **not stored** as a mutable number. It is derived by summing an append-only sequence of deltas, one row per change. Reasons:

- **Audit.** Every balance change has a row, with a reason, timestamp, and link to whatever caused it.
- **Reconciliation is clean.** When HCM's batch disagrees with our local view, we insert a correction row rather than overwriting a number.
- **Reversal is cheap.** Cancelling a synced request becomes "append a `+N CANCELLATION_REFUND` row," not "edit the old row."
- **No destructive state.** Historical rows are never changed, so bugs in one operation can't corrupt the past.

**Table: `ledger`**

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER (PK) | Auto-increment. |
| `employee_id` | TEXT | Indexed as part of composite. |
| `location_id` | TEXT | Indexed as part of composite. |
| `delta` | INTEGER | Signed integer days. `+` grant/refund, `−` deduction. |
| `event_type` | TEXT | Enum, see below. |
| `request_id` | TEXT (nullable) | Foreign key to `requests.id` for rows tied to a request. |
| `idempotency_key` | TEXT (nullable) | Key used on the HCM write that produced this row. |
| `metadata_json` | TEXT (nullable) | Free-form JSON for rare cases (e.g. HCM batch reference). |
| `created_at` | DATETIME | Server time. Never edited. |

**Indexes:** composite on `(employee_id, location_id, created_at)` for fast balance projection. Secondary on `request_id` for lookups.

**`event_type` values:**

| Event type | Meaning | Produced by |
|---|---|---|
| `INITIAL_GRANT` | First time we see a balance for this employee/location | HCM batch sync, or an admin seed |
| `TIME_OFF_DEDUCTION` | A request settled against HCM successfully | Request lifecycle |
| `CANCELLATION_REFUND` | A previously-synced request was cancelled | Request lifecycle |
| `ANNIVERSARY_BONUS` | HCM granted extra days (inferred from batch) | Reconciliation |
| `RECONCILIATION_CORRECTION` | HCM's batch disagreed with our view; we aligned | Reconciliation |
| `MANUAL_ADJUSTMENT` | Admin-driven correction | Admin endpoint |

**Balance projection:**

```
settled_balance(employee, location)
    = SUM(ledger.delta WHERE employee_id = ? AND location_id = ?)

pending_holds(employee, location)
    = SUM(requests.days WHERE employee_id = ? AND location_id = ?
                        AND status IN ('PENDING_APPROVAL',
                                       'APPROVED_SYNCING',
                                       'SYNC_RETRY'))

available_balance(employee, location)
    = settled_balance - pending_holds
```

The `available_balance` is what the UI and the validation layer use when checking whether a new request can be submitted.

### 5.2 Requests

The `requests` table holds the lifecycle state for every time-off request. Unlike the ledger, it is **mutable** — statuses transition over time.

**Table: `requests`**

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT (PK) | UUID. Generated server-side. |
| `employee_id` | TEXT | Who the request is for. |
| `location_id` | TEXT | Which balance to deduct from. |
| `start_date` | DATE | First day of leave. |
| `end_date` | DATE | Last day of leave, inclusive. |
| `days` | INTEGER | Pre-computed working-day count (Sat/Sun excluded). |
| `status` | TEXT | See Section 6 for enum values. |
| `manager_id` | TEXT (nullable) | Set when approved or rejected. |
| `rejection_reason` | TEXT (nullable) | Free text. |
| `client_idempotency_key` | TEXT (nullable, unique) | From the `Idempotency-Key` request header. |
| `hcm_idempotency_key` | TEXT (nullable) | Server-generated, sent to HCM on write. |
| `hcm_sync_attempts` | INTEGER | Retry counter. |
| `hcm_last_error` | TEXT (nullable) | Most recent HCM error, for debugging. |
| `synced_at` | DATETIME (nullable) | Set when HCM confirms. |
| `cancelled_at` | DATETIME (nullable) | Set on cancellation. |
| `created_at` | DATETIME | Server time. |
| `updated_at` | DATETIME | Updated on every status transition. |

**Indexes:** `(employee_id, status)` for queue/history queries, `(manager_id, status)` for manager inbox, `client_idempotency_key` unique for deduplicating submissions.

### 5.3 Why ledger and requests are separate tables

Another way to model this would be to put pending holds on the ledger directly — write a `-2 HOLD` row when the employee submits, then later either confirm it (on HCM sync) or reverse it (on rejection or cancellation). We chose not to. Mixing pending state into the ledger conflates two different things: the *lifecycle of a request* and the *history of settled balance changes*. Keeping them on separate tables means:

- The ledger only contains facts that HCM should also have, which makes reconciliation against HCM clean.
- Pending holds live and die with the request row, without polluting the audit log with transient states.
- Cancelling an unsynced request is a one-line status change, not an append-reverse on the ledger.

### 5.4 SQLite specifics

- All `DATETIME` columns store ISO-8601 UTC strings.
- SQLite is configured with `PRAGMA journal_mode=WAL` for better concurrency on read. Writes remain serialised at the file level, which reinforces the concurrency strategy in Section 9.
- Foreign keys enabled with `PRAGMA foreign_keys=ON`.
- Migrations managed by TypeORM's migration runner, checked into `src/migrations/`.

---

## 6. Request lifecycle state machine

### 6.1 States

| State | Meaning |
|---|---|
| `PENDING_APPROVAL` | Employee submitted. Awaiting manager decision. Hold placed on local balance. |
| `REJECTED` | Manager rejected. Terminal. Hold released. No HCM call made. |
| `APPROVED_SYNCING` | Manager approved. First HCM write is in flight. |
| `SYNC_RETRY` | HCM write failed transiently. Retry scheduled. |
| `SYNCED` | HCM confirmed the deduction. Ledger row exists. |
| `FAILED` | HCM rejected or retries exhausted. Terminal. Hold released. |
| `CANCELLED` | Employee cancelled before leave started. Terminal. Hold released (and compensating HCM call made if already synced). |
| `COMPLETED` | Leave `end_date` has passed. Terminal. Stays deducted. |

### 6.2 Transitions

```
                         ┌─────────────────┐
          submit ───────▶│ PENDING_APPROVAL│
                         └────────┬────────┘
                                  │
                      ┌───────────┼────────────┐
                      │           │            │
                 manager       manager       employee
                  rejects      approves      cancels
                      │           │            │
                      ▼           ▼            ▼
                  ┌─────────┐  ┌─────────────────┐  ┌───────────┐
                  │REJECTED │  │APPROVED_SYNCING │  │ CANCELLED │
                  └─────────┘  └────────┬────────┘  └───────────┘
                                        │
                              ┌─────────┼──────────┐
                              │         │          │
                           HCM ok    HCM 4xx    HCM 5xx/timeout
                              │         │          │
                              ▼         ▼          ▼
                         ┌────────┐ ┌──────┐ ┌────────────┐
                         │ SYNCED │ │FAILED│ │SYNC_RETRY  │
                         └───┬────┘ └──────┘ └─────┬──────┘
                             │                     │
                             │                     │ (retries)
                             │                     ▼
                             │              back to APPROVED_SYNCING
                             │              or eventually FAILED
                             │              (policy in Section 7.3)
                             │
                       end_date passes
                             │
                             ▼
                       ┌───────────┐
                       │ COMPLETED │
                       └───────────┘

  (Cancellation is also allowed from APPROVED_SYNCING, SYNC_RETRY, and SYNCED,
   as long as start_date is in the future. See Section 6.4.)
```

### 6.3 Transition rules

| From | To | Trigger | Who | Guard |
|---|---|---|---|---|
| (starting state) | `PENDING_APPROVAL` | `POST /requests` | Employee (self) | `available_balance >= days`; dates are valid; `days > 0`. |
| `PENDING_APPROVAL` | `REJECTED` | `POST /requests/:id/reject` | Manager | Manager manages this employee. |
| `PENDING_APPROVAL` | `APPROVED_SYNCING` | `POST /requests/:id/approve` | Manager | Manager manages this employee. |
| `APPROVED_SYNCING` | `SYNCED` | HCM 2xx + idempotency verification | System | — |
| `APPROVED_SYNCING` | `FAILED` | HCM 4xx | System | — |
| `APPROVED_SYNCING` | `SYNC_RETRY` | HCM 5xx, timeout, network error | System | `hcm_sync_attempts < MAX_ATTEMPTS` (Section 7.3). |
| `SYNC_RETRY` | `APPROVED_SYNCING` | Retry worker fires | System | — |
| `SYNC_RETRY` | `FAILED` | Retries exhausted | System | `hcm_sync_attempts >= MAX_ATTEMPTS`. |
| `PENDING_APPROVAL`, `APPROVED_SYNCING`, `SYNC_RETRY`, `SYNCED` | `CANCELLED` | `POST /requests/:id/cancel` | Employee (self) | `start_date > now`. Compensation steps differ (Section 6.4). |
| `SYNCED` | `COMPLETED` | Nightly / on-read observation | System | `end_date < now`. |

Any attempt to transition from a terminal state (`REJECTED`, `FAILED`, `CANCELLED`, `COMPLETED`) returns `409 Conflict`.

### 6.4 Cancellation behaviour

Cancellation differs by the current state:

| Current state | Action on cancel |
|---|---|
| `PENDING_APPROVAL` | Mark `CANCELLED`. No HCM call is needed because nothing had been sent to HCM yet — HCM's balance doesn't change, and we don't touch the ledger either. The hold disappears on its own once the status changes, since `CANCELLED` is not one of the statuses counted in `pending_holds`. |
| `APPROVED_SYNCING` / `SYNC_RETRY` | Mark `CANCELLED`. If an HCM write was in flight, let it complete. If it succeeds, the follow-up compensating call runs (see below). If it fails, we're already where we want to be. |
| `SYNCED` | Mark `CANCELLED`. Issue a compensating HCM write (`+days`) with a fresh idempotency key. On success, append a `CANCELLATION_REFUND` row to the ledger. On failure, go to `SYNC_RETRY`-style retry behaviour for the compensation. |
| `COMPLETED`, `CANCELLED`, `REJECTED`, `FAILED` | Return `409 Conflict`. |

**Important:** the service does not allow cancellation once `start_date <= now`. This is to avoid retroactive adjustments to balances for leave that was already taken.

### 6.5 Balance implications at each state

| State | Contributes to `pending_holds`? | Ledger row exists? |
|---|---|---|
| `PENDING_APPROVAL` | Yes | No |
| `APPROVED_SYNCING` | Yes | No |
| `SYNC_RETRY` | Yes | No |
| `SYNCED` | No | Yes (`TIME_OFF_DEDUCTION`) |
| `COMPLETED` | No | Yes (same row as SYNCED) |
| `REJECTED` | No | No |
| `FAILED` | No | No |
| `CANCELLED` (was synced) | No | Yes (original deduction **and** a refund row) |
| `CANCELLED` (was not synced) | No | No |

---

## 7. HCM integration

### 7.1 What we assume HCM provides

These are documented assumptions about the HCM contract. The mock server built for testing (Section 11.2) implements exactly this surface.

| Endpoint | Method | Purpose |
|---|---|---|
| `/balances/:employeeId/:locationId` | GET | Read the current balance. Used for optional pre-checks and for verification after a write. |
| `/deductions` | POST | Apply a signed integer delta against a balance. Accepts `Idempotency-Key` header. |
| `/deductions/:idempotencyKey` | GET | Look up a previously-submitted operation by its idempotency key. |
| `/` (our endpoint) | POST | HCM pushes the full balance corpus here. Format: `[{ employeeId, locationId, balance }, ...]`. |

**Key assumption:** HCM honours the `Idempotency-Key` header by returning the original response for any duplicate call. If the real HCM doesn't, Section 7.5 covers the fallback.

### 7.2 Idempotency and safe retries

Every outbound HCM write carries an idempotency key generated by our service (`req_<uuid>` stored on the `requests` row). The same key is reused on every retry of the same logical operation, including after process restarts.

This protects against two nasty cases:

1. **Lost response.** We called HCM, HCM applied the change, but the response never got back to us (network eat, process restart, etc.). We retry with the same key. HCM recognises it and returns the cached result. No double-deduction.
2. **Transient 5xx.** HCM was busy, returned 503. We retry with the same key. HCM processes it this time.

For compensating (cancellation) writes, a **different** idempotency key is generated, because it's a logically separate operation.

### 7.3 Retry policy

| Parameter | Value |
|---|---|
| Max attempts | 3 after the initial call (4 total) |
| Backoff | Exponential: 1s, 2s, 4s |
| Total window | Roughly 7 seconds |
| Retryable on | HTTP 5xx, request timeout, connection error, DNS error |
| Not retryable on | HTTP 4xx (business rejections), response-parse failures |

After attempts are exhausted, the request transitions to `FAILED`. At that point the employee sees a failure message, the manager's approval is effectively undone, and the hold is released.

A stale `APPROVED_SYNCING` safety net runs periodically (every minute) and nudges any rows stuck without progress back into `SYNC_RETRY`. This is defensive: in theory the in-process retry worker should handle everything, but a process restart mid-retry would otherwise leave a request stranded.

### 7.4 Batch reconciliation

#### 7.4.1 Trigger

HCM pushes its full balance corpus to `POST /hcm/batch-sync` on whatever cadence the HCM operator configures. Recommended: every 15 minutes in production. Lower bound is governed by how much stale data is acceptable for independent HCM mutations to appear to users.

Payload:

```json
{
  "batchId": "batch_2026-04-24T10:00Z",
  "generatedAt": "2026-04-24T10:00:00Z",
  "balances": [
    { "employeeId": "E001", "locationId": "NYC", "balance": 12 },
    { "employeeId": "E002", "locationId": "NYC", "balance":  7 }
  ]
}
```

The endpoint is idempotent on `batchId`: a repeated delivery of the same batch is a no-op.

#### 7.4.2 Reconciliation algorithm

For each `(employee, location)` in the batch:

1. Compute `expected = settled_balance(employee, location)` from the ledger.
2. Read `hcm_reported = balance` from the batch row.
3. Compute `delta = hcm_reported − expected`.
4. If `delta != 0`, append a single row to the ledger:
    - If we can infer the cause (e.g. exactly one anniversary event registered elsewhere at a known amount), use `ANNIVERSARY_BONUS`.
    - Otherwise, `RECONCILIATION_CORRECTION`.
    - Store the `batchId` in `metadata_json` for traceability.
5. Emit a structured log line with the `(employee, location, expected, hcm_reported, delta)` tuple so drift is observable.

For `(employee, location)` pairs present in the batch but unknown locally, insert an `INITIAL_GRANT` row with `delta = balance`.

For pairs present locally but missing from the batch, emit a warning but do not delete. This could be a batch configuration issue, and deleting historical balances silently is a much worse failure mode than showing stale data briefly.

#### 7.4.3 Handling in-flight requests during reconciliation

Two things to get right here, or reconciliation will "correct" state that's already correct and cause more problems than it fixes.

**Rule 1: compare HCM to `settled_balance`, not `available_balance`.**

HCM only knows about operations we've successfully sent to it. Pending holds (requests still in `PENDING_APPROVAL`, `APPROVED_SYNCING`, or `SYNC_RETRY`) haven't reached HCM yet, so they shouldn't count in the comparison. `settled_balance` is the ledger sum — the same set of operations HCM has. That's the apples-to-apples comparison.

**Rule 2: watch for a timing race between batch generation and sync.**

The batch captures HCM's balance at the moment HCM built it. By the time our service receives and processes that batch, our ledger might have moved on — specifically, a request that was in flight when HCM generated the batch may have finished syncing by the time we process it.

Concrete timeline:

```
10:00:00   HCM builds a batch. Alice's balance in HCM: 10 days.
10:00:01   Our service finishes syncing Alice's 2-day request.
           Ledger appends -2. settled_balance drops to 8.
10:00:02   We receive the batch. It says Alice = 10. Our ledger says 8.
           Naive reconciliation: "gap of 2, insert +2 correction."
           That would undo the legitimate deduction we just wrote.
```

The fix: before inserting a correction, compare the batch's `generatedAt` timestamp against the most recent `synced_at` for any `SYNCED` request touching the same `(employee, location)`. If the sync happened *after* the batch was generated, skip that row for this batch and let the next batch confirm. The next batch will be generated *after* the sync and will naturally agree with our ledger.

In short: we trust our ledger when we know for a fact it reflects a change the batch hadn't seen yet.

### 7.5 Defensive verification

Two ways HCM can deceive us, and what we do about each.

1. **HCM response is lost in flight.** We retry with the same idempotency key. HCM recognises the duplicate and returns the original result. Covered in Section 7.2.

2. **HCM returns `200 OK` but silently didn't apply the change.** Immediately after a 2xx response, we call `GET /deductions/:idempotencyKey` to confirm HCM has the record on file. Three outcomes:
    - Record found: mark the request `SYNCED` and append the ledger row.
    - Record missing: treat as a verification failure. The request goes back to `SYNC_RETRY` and the write is attempted again with the same idempotency key.
    - Lookup endpoint itself unavailable: log a warning and rely on the next batch reconciliation to catch any drift.

The three mechanisms together give us layered protection, each catching what the previous one might miss:

| Layer | What it catches | Latency |
|---|---|---|
| Idempotency key on the write | Lost responses, safe retries | Immediate |
| Per-request verification after a 2xx | HCM silently accepting without applying | Sub-second |
| Batch reconciliation | Anything the first two miss, plus independent HCM changes | Next batch cycle |

Per-request verification doubles the outbound HCM traffic compared to a naive "trust the 200" approach. That cost is accepted: a balance-tracking service prioritises correctness over efficiency, and the PDF explicitly asks for defensive behaviour against HCM's unreliable error signalling.

### 7.6 HCM client architecture

Single `HcmClient` service in the infrastructure layer. Responsibilities:

- Wraps `axios` with configured timeouts. (Picked over `fetch` for its mature interceptor support, which makes the idempotency header and retry logic cleaner to plug in, and for its typed error surface.)
- Attaches the idempotency key header.
- Implements the retry policy in Section 7.3.
- Surfaces typed errors: `HcmBusinessError` (4xx), `HcmTransientError` (5xx/timeout/network), `HcmVerificationError` (suspicious 2xx that didn't echo through verification).
- Emits structured logs and metrics (Section 14).

---

## 8. API surface

### 8.1 Design principles

- REST over JSON.
- State transitions on requests use **action endpoints** (`POST /requests/:id/approve`), not generic PATCH on a `status` field. Each action is a distinct route with its own authorisation guard.
- Resource identifiers are opaque strings (UUIDs), never auto-increment integers exposed to clients.
- `Idempotency-Key` header accepted on all non-GET endpoints that create or mutate state. For endpoints where replays are meaningful, the key is persisted and enforced.
- Errors return a consistent shape (Section 10).

### 8.2 Employee-facing

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/employees/:id/balances?locationId=X` | Current available and settled balance, plus a breakdown of pending holds. |
| `POST` | `/requests` | Submit a new time-off request. Requires `Idempotency-Key` header. |
| `GET` | `/employees/:id/requests?status=...&page=...&limit=...` | List an employee's own requests with filters and pagination. |
| `GET` | `/requests/:id` | Detail view for a single request, including its ledger trail. |
| `POST` | `/requests/:id/cancel` | Cancel (only allowed from non-terminal states with `start_date > now`). |

### 8.3 Manager-facing

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/requests?status=PENDING_APPROVAL&managerId=X&page=...&limit=...` | Manager's approval queue. |
| `POST` | `/requests/:id/approve` | Approve the request. |
| `POST` | `/requests/:id/reject` | Reject with optional `{ reason: "..." }` body. |

### 8.4 HCM-inbound

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/hcm/batch-sync` | HCM pushes the full balance corpus. Idempotent on `batchId`. |
| `POST` | `/hcm/events` | *(Optional future use.)* HCM pushes individual events such as anniversary bonuses. Not in scope for the initial build; batch covers this case. |

These endpoints are authenticated with a shared secret (a static API key header) for the exercise. In production this would be mTLS, HMAC-signed payloads, or a service-to-service JWT.

### 8.5 Admin / ops

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/admin/reconcile` | Force a reconciliation pass for a given `(employeeId, locationId)`. Useful for debugging and catching up after HCM outages. |
| `GET` | `/admin/drift-report` | List `(employee, location)` pairs where local `settled_balance` disagrees with the most recent HCM-reported balance by more than a configurable threshold. |
| `GET` | `/requests/:id/ledger` | Full ledger trail for a single request (complement to Section 8.2). |

### 8.6 Authorisation matrix

Documented as intent; the exercise implements a simplified role check based on a header (`X-Role`, `X-Actor-Id`) rather than a full auth integration. In production, replace with SSO-issued JWTs.

| Role | Allowed |
|---|---|
| Employee | Read their own balance and requests; submit and cancel their own requests. |
| Manager | Everything an Employee can do for themselves, plus list and approve/reject requests in their team. Cannot approve their own requests. |
| HCM service account | `POST /hcm/batch-sync` only. |
| Admin | All endpoints, including `/admin/*`. |

### 8.7 Idempotency key semantics

`POST /requests` accepts an `Idempotency-Key` header (UUIDv4 recommended). The same key submitted twice within a retention window (24h by default) returns the original response without creating a second request. The key is scoped to the employee so two different employees can coincidentally reuse the same key without collision.

For `POST /requests/:id/approve`, `/reject`, `/cancel`, we don't require an explicit idempotency header. Instead, the state machine itself enforces safety: a second call hits a terminal or moved-on state and gets `409 Conflict`. This is a deliberate asymmetry between `create` (where the resource ID is chosen server-side and needs deduping) and `state transition` (where the resource ID already pins the identity).

### 8.8 Pagination

Cursor-based (`?cursor=...&limit=50`). Default limit 20, max 200. Responses include a `nextCursor` when more data exists. Chosen over offset/limit because it's stable under inserts.

---

## 9. Concurrency strategy

### 9.1 The race we're protecting against

Employee has 10 days. Two `POST /requests` calls arrive at the same moment, each for 6 days. Without serialisation, both read `available_balance = 10`, both pass the check, and the employee ends up with a committed total of 12 days used from a 10-day pool.

The primitive used to serialise is a **per-key mutex** keyed on `(employeeId, locationId)`. Only operations that mutate balance or affect pending holds for that key acquire the mutex. Operations touching different keys proceed in parallel.

### 9.2 Where the mutex lives

An in-process `MutexRegistry` that hands out `async-mutex` locks keyed by the composite string `employee:location`. Lock scope:

- **Submit** (`POST /requests`): acquire → re-read `available_balance` → validate → insert `requests` row → release.
- **Approve** (`POST /requests/:id/approve`): acquire → transition state → kick off HCM call → release. The HCM call itself happens outside the lock so a slow HCM doesn't block every other request for that employee.
- **HCM-result handler** (internal): acquire → update status → append ledger row if synced → release.
- **Cancel**: same pattern.
- **Reconciliation**: acquire per `(employee, location)` during that key's reconcile step; release before moving to the next pair.

Critical rule: **HCM network calls never happen while a mutex is held.** The mutex wraps the "decide and record" part, not the "call out" part. Otherwise a slow HCM could serialise traffic across all users for a given employee.

### 9.3 Failure modes of an in-process mutex

- **Process crash while holding.** Locks are in-memory only, so a restart releases them. On restart, any requests left in `APPROVED_SYNCING` with stale `updated_at` are picked up by the background retry sweeper (Section 7.3) and continue from there.
- **Two instances of the service.** This design is explicitly single-instance. Running two copies behind a load balancer would let the same `(employee, location)` race across processes, which the in-process mutex does not guard against.

### 9.4 Scaling path

For a multi-instance deployment the mutex would be replaced with one of:

- **Redis Redlock** using the same key scheme. Straightforward migration.
- **Database-level serialisation.** Using `SELECT ... FOR UPDATE` on the `(employee, location)` row of a small `balance_snapshots` table. Correct but bottlenecks on SQLite (file-level lock) and requires a real RDBMS.
- **Partitioned consumers.** Route all writes for a given `(employee, location)` to the same service instance by hashing. Mutex stays in-process but work is sharded.

We pick the in-process option for this exercise to stay simple and SQLite-friendly. The scaling path is documented so the choice is visibly intentional rather than a ceiling we hit by accident.

---

## 10. Error handling and failure modes

### 10.1 Error response shape

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Available balance is 4 days, requested 5.",
    "details": { "available": 4, "requested": 5 }
  }
}
```

All errors include a machine-readable `code` (from a closed enum) and a human-readable `message`. Optional `details` carry structured context.

### 10.2 Error categories

| Category | HTTP status | Examples |
|---|---|---|
| Validation | 400 | Missing field, invalid date range, `days <= 0`. |
| Authorisation | 401 / 403 | Missing role header, manager touching another team's request. |
| Not found | 404 | Request, employee, or balance not found. |
| Conflict | 409 | Invalid state transition, duplicate idempotency key with a different payload. |
| Business rule | 422 | Insufficient balance, cancel after `start_date`. |
| Upstream error | 502 / 503 | HCM is unreachable or returned an unhandled error. |
| Server error | 500 | Unexpected bug; logged with context. |

### 10.3 Request-scoped observability

Every request is assigned a `traceId` on entry (either propagated from the client or generated) and echoed back in a response header. Logs include the `traceId`, the state transition being attempted, and the outcome.

---

## 11. Test strategy

The PDF weights tests heavily: *"the value of your work lies in the rigor of your tests."* Tests are a primary deliverable and the document below is explicit about what will be tested and how.

### 11.1 Layers

| Layer | Scope | Tools |
|---|---|---|
| Unit | Pure functions: state machine validators, balance projection, working-day calculator, idempotency-key generator. | Jest |
| Integration | Whole HTTP → service → DB → mock HCM round-trip. The bulk of the suite. | Jest + Supertest + live Express mock HCM |
| Contract | The assumptions our HCM client makes, asserted against the mock HCM. Ensures mock and expected real HCM agree. | Jest |
| E2E smoke | A single happy-path flow through the running service and mock HCM. | Jest + Docker Compose (or in-process) |

The integration layer is the largest and most valuable for this domain, because the interesting behaviour is in coordination between the service, the DB, and HCM.

### 11.2 Mock HCM server

A real HTTP server (Express) implemented in `test/mock-hcm/`. Features:

- In-memory balance store, seedable per-test.
- Endpoints matching Section 7.1.
- Configurable failure modes exposed via control endpoints: return 5xx, return 4xx, sleep before responding, drop the response, silently accept an invalid write.
- Configurable clock, so reconciliation and batch scenarios can be deterministic.
- Respects the `Idempotency-Key` header: replays return cached responses.

Each test case configures the mock's behaviour at the start. Tests run in parallel isolation by using a fresh SQLite file per worker.

### 11.3 Scenario coverage

The TRD commits to tests for the following. Each scenario maps to a named test file, listed in the README scenario checklist.

**Happy path**

1. Submit → approve → HCM confirm → `SYNCED`. Ledger shows one `TIME_OFF_DEDUCTION` row; `requests.status = SYNCED`; available balance recomputes correctly.

**State machine**

2. Manager rejects before HCM is called → `REJECTED`, no ledger row, hold released.
3. Employee cancels in `PENDING_APPROVAL` → `CANCELLED`, no ledger row.
4. Employee cancels in `SYNCED` → compensating HCM call fires, ledger gains a `CANCELLATION_REFUND` row, original row stays.
5. Attempt to approve an already-approved request → `409 Conflict`; nothing changes.
6. Attempt to cancel after `start_date` → `422 Unprocessable`; nothing changes.
7. Attempt any transition from a terminal state → `409`.

**Concurrency**

8. Two `POST /requests` for the same employee, each 6 days, against a 10-day balance. Exactly one succeeds. The other returns `422 INSUFFICIENT_BALANCE`.
9. Same `Idempotency-Key` submitted twice. One request is created. Both calls return the same response body.
10. Manager calls `/approve` twice in parallel. First wins, second gets `409`.

**HCM integration**

11. HCM returns 4xx on the deduction → `FAILED`, hold released, no ledger row.
12. HCM returns 5xx once, succeeds on retry → `SYNCED`, one ledger row, retry counter observable.
13. HCM returns 5xx through all retries → `FAILED`, hold released.
14. HCM response lost (mock "drops" the response) → our service retries with the same idempotency key → mock returns the cached result → `SYNCED`, exactly one deduction visible on the mock side.
15. HCM 200 OK but no corresponding record on lookup (silent acceptance failure) → verification step detects it and either retries or surfaces as `SYNC_VERIFICATION_FAILED`.

**Reconciliation**

16. Batch arrives with a balance higher than our computed one (anniversary bonus case). Ledger gets an `ANNIVERSARY_BONUS` or `RECONCILIATION_CORRECTION` row; local balance converges.
17. Batch arrives with a balance lower than ours (rare but possible if an admin edited HCM directly). Correction row inserted.
18. Batch arrives during a `SYNCED` request that raced the batch. No spurious correction inserted; the next batch confirms parity.
19. Repeated delivery of the same `batchId` is a no-op.

**Working-day calculation**

20. Request spanning a weekend (Fri–Mon) computes as 2 working days, not 4.
21. Request fully inside a weekend (Sat–Sun) is rejected (`days == 0`).
22. Single-day request on a Monday counts as 1.

**Authorisation (intent-level)**

23. Employee hits `/approve` → 403.
24. Manager approves their own request → 403.
25. Missing or malformed role header → 401.

### 11.4 Coverage targets

- Line/branch coverage on domain code (state machine, balance projection, reconciliation, HCM client): **≥ 90 %**.
- Coverage on controllers and DTOs: **≥ 80 %**.
- Coverage on scaffolding (main.ts, module configuration): not measured, not interesting.

Coverage is reported by Jest's built-in collector and included in the repository as an HTML report at submission time.

### 11.5 What we don't test

- NestJS internals and TypeORM behaviour. We trust the frameworks.
- Exhaustive permutations of date inputs. We sample: weekday, weekend, across-weekend, across-month, single-day.
- HCM's internal correctness. We test our reaction to HCM's behaviour, not HCM itself.

---

## 12. Alternatives considered

### 12.1 Snapshot balance vs event-sourced ledger

**Snapshot:** a single row `(employee_id, location_id, balance)` that we UPDATE on every change. Simpler to read. Rejected because it loses history, makes reconciliation "just overwrite the number and hope," and makes cancellation reversal ambiguous when concurrent events have happened.

**Ledger (chosen):** append-only. Slightly more work to compute current balance (solved with a composite index and a cached projection where needed), but every audit and reconciliation question becomes obvious.

### 12.2 Where to record pending holds

**On the ledger as `HOLD` / `RELEASE_HOLD` rows.** Rejected: conflates request lifecycle with settled history. Makes the ledger noisy and makes reconciliation against HCM harder because HCM has no notion of our pending holds.

**On the requests table, excluded from settled balance (chosen).** Clean separation between "things HCM should know about" and "things we're still figuring out."

### 12.3 HCM batch transport

**Pull on a cron schedule.** Rejected because the PDF describes HCM "sending" the corpus, and because pull puts the timing decision on our service rather than HCM.

**Push to our endpoint (chosen).** HCM decides when it's ready. Our service is passive.

**Streaming change feed.** Would be ideal but out of scope for the HCM contract assumed here.

### 12.4 Concurrency primitive

**In-process mutex (chosen).** Simplest working option for a single-instance service.
**Database-level row lock.** Correct, but SQLite's file-level lock makes this bottleneck-prone, and TypeORM's support for `FOR UPDATE` on SQLite is limited.
**Redis distributed lock.** Overkill for this exercise. Added as the explicit scaling path in Section 9.4.
**Optimistic concurrency with version columns.** Works, but shifts retry logic into the application for every conflict. Worth considering if we ever need it to survive process restarts without full serialisation.

### 12.5 REST verb style for state transitions

**Generic PATCH on `status`.** Rejected: puts the state machine in the client's hands, complicates authorisation (the handler has to parse the body to decide), and makes audit logs less legible.

**Action endpoints (`POST /requests/:id/approve`) (chosen).** Each transition is its own route with its own guard. Maps 1:1 to the state machine.

### 12.6 ORM choice

**Prisma.** Nice DX, but heavier to set up cleanly in NestJS, separate migration tool, and its SQLite integration has sharp edges.
**Raw SQL via `better-sqlite3`.** Fastest and most transparent. Rejected because typing and migration management would eat time better spent on tests.
**TypeORM (chosen).** First-party NestJS integration, built-in migration runner, acceptable SQLite support. Good default for this stack under time pressure.

### 12.7 Swagger vs hand-written docs

**Hand-written Markdown.** Would drift from the actual code immediately.
**OpenAPI generated from NestJS decorators (chosen).** Always in sync with the controllers. Exposed at `/api/docs` via `@nestjs/swagger`. Minimal extra work.

---

## 13. Security considerations

### 13.1 Authentication

The exercise uses simple header-based roles (`X-Role`, `X-Actor-Id`) for brevity. The TRD documents the intended production setup:

- Employees and managers authenticate via SSO (OIDC, typically).
- The HCM service account authenticates via mTLS or an HMAC-signed request body. HMAC is preferred for webhook-style traffic because it's resistant to replay when combined with a nonce or timestamp.
- Admin routes require a separate credential (typically a break-glass role, not daily-use).

### 13.2 Authorisation

Enforced per endpoint, not by generic middleware guessing from the body. Managers cannot approve their own requests. Employees cannot read or act on other employees' data. HCM service account is locked to `/hcm/*` only.

### 13.3 Input validation

- All DTOs use `class-validator` decorators, fail closed on unknown fields (`whitelist: true, forbidNonWhitelisted: true`).
- Date inputs are parsed to native `Date`, not stored as raw strings.
- IDs are validated as UUIDs where applicable.
- Query parameters are coerced with explicit transforms; no reliance on type coercion.

### 13.4 SQL injection

Queries go through TypeORM's query builder or repository methods exclusively. Raw SQL is used only in migrations, which are developer-authored and reviewed.

### 13.5 Idempotency key tampering

`Idempotency-Key` values are stored verbatim but never interpreted as data. A mismatched body for the same key returns `409` to prevent overwrite attacks.

### 13.6 Secrets

HCM client credentials and the shared HCM webhook secret are read from environment variables, never committed. `.env.example` is checked in with placeholder values.

### 13.7 Rate limiting and abuse

Out of scope for this exercise. Noted as a future addition, most likely as a shared middleware at the ingress (not per-instance token buckets).

---

## 14. Observability

### 14.1 Logging

Structured JSON logs (one event per line). Every log line carries:

- `traceId` (per request)
- `actorId` and `role`
- `requestId` (the time-off request, when relevant)
- `event` (`request.submitted`, `hcm.write.succeeded`, `reconciliation.corrected`, etc.)
- `outcome` (`ok`, `conflict`, `failure`, `retry`)

Levels: `info` for expected flow, `warn` for retryable and recoverable conditions, `error` for terminal failures and internal bugs.

### 14.2 Metrics

Exposed via a `/metrics` endpoint in Prometheus text format (or stubbed out if the deployment doesn't use Prometheus). Key metrics:

- `hcm_calls_total{outcome}` (counter)
- `hcm_call_duration_seconds` (histogram)
- `requests_by_status{status}` (gauge, sampled)
- `reconciliation_drift_total` (counter)
- `retry_attempts_total` (counter)

### 14.3 Tracing

Not implemented for the exercise. In production, OpenTelemetry-style spans through NestJS interceptors would be the expected next step.

### 14.4 Audit trail

The ledger itself is the audit trail for balance changes. The `requests` table plus `updated_at` timestamps and a small `request_transitions` audit log (optional, not in MVP) cover lifecycle changes.

---

## 15. Out of scope and future work

| Item | Why deferred | Recommended path |
|---|---|---|
| Multiple leave types | Doubles the modelling work for limited marginal insight in this exercise. | Add a `leave_type_id` column to `requests` and to the ledger, scope balances by `(employee, location, leave_type)`. |
| Half-days and hourly leave | Same reason. | Change `days` to a decimal (or minutes) and extend the working-day calculator. |
| Public holidays | Requires a holiday calendar service. | Externalise to a "calendar" service or integrate a library such as `date-holidays`. |
| Accrual policies | Separate problem domain (accrual rules vary per jurisdiction and role). | A background job that runs nightly and emits `ACCRUAL_GRANT` ledger rows. |
| Multi-tenancy | Adds a `tenant_id` scope everywhere. | Retrofit via a `tenant_id` column, enforce in a repository base class. |
| Full SSO / auth | Relies on the organisation's identity provider. | Replace the header-based role check with NestJS auth guards reading JWT claims. |
| Horizontal scaling | Requires moving the mutex out of the process. | Redis Redlock on the same key scheme. |
| Notifications | Out of the core sync problem. | Emit domain events; a separate notifications service subscribes. |
| Rate limiting | Infra concern. | Ingress-level (e.g. Kong, Envoy, API Gateway). |

---

## Appendix A. Glossary

- **HCM** — Human Capital Management system. External source of truth for employment data including leave balances (e.g. Workday, SAP SuccessFactors).
- **Ledger** — Append-only table of balance-affecting events. Current balance is the sum of deltas.
- **Hold** — A pending request's claim on available balance, visible to the user but not yet reflected in HCM.
- **Settled balance** — What the ledger currently sums to. Matches HCM (after reconciliation).
- **Available balance** — `settled_balance - pending_holds`. What the UI and submission validator use.
- **Idempotency key** — A client- or server-generated unique identifier per operation, honoured by the receiver to deduplicate retries.
- **Batch sync** — HCM's periodic push of its full balance corpus, used for reconciliation and independent-mutation detection.
