# Time-Off Microservice

Backend microservice for managing the lifecycle of employee time-off requests while keeping leave balances in sync with an external HCM (Human Capital Management) system.

The full design is in [`docs/TRD.md`](docs/TRD.md). The README is intentionally focused on **getting up and running** and the **endpoint surface**.

## Stack

- **Runtime:** Node.js 22+
- **Framework:** NestJS 11 (strict TypeScript)
- **Database:** SQLite via TypeORM
- **API docs:** Swagger / OpenAPI at `/api/docs`
- **Testing:** Jest + Supertest + a real Express mock HCM server

## Prerequisites

- Node.js **22 or newer** (the project is built and tested on Node 22; older versions may work but are unsupported).
- npm **10 or newer** (ships with Node 22).

Verify with:

```bash
node --version   # should print v22.x or newer
npm --version    # should print 10.x or newer
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your local environment file from the template
cp .env.example .env
```

The `.env.example` ships with sensible defaults for local development; **most people don't need to edit it**. The values you might want to tweak:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `DATABASE_PATH` | `data/time-off.sqlite` | Path for the SQLite file |
| `DB_SYNCHRONIZE` | `true` | Auto-create tables from entities (dev only) |
| `HCM_BASE_URL` | `http://localhost:4000` | Where the real (or mock) HCM lives |
| `HCM_TIMEOUT_MS` | `5000` | Per-request timeout for HCM calls |
| `HCM_MAX_RETRIES` | `3` | Retry attempts after the first try |
| `HCM_VERIFY_AFTER_WRITE` | `true` | After a 2xx, look the deduction up to confirm it landed |
| `RECONCILIATION_GRACE_MS` | `30000` | In-flight grace window for batch reconciliation |

## Running the application

There are two ways to run the service.

### Development mode (recommended for local work)

Auto-reloads on file changes:

```bash
npm run start:dev
```

### Production-style

Build first, then run the compiled output:

```bash
npm run build
npm run start:prod
```

Either way, the service listens on `http://localhost:3000` (or whatever `PORT` is set to). The data folder is created automatically; the SQLite file appears the first time the app boots.

### What you should see when it's up

In the terminal you'll see Nest's bootstrap output ending with something like:

```
[Nest] LOG [NestApplication] Nest application successfully started
```

Verify in another terminal:

```bash
# 1. Health check (public, no auth)
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}

# 2. Swagger UI (open in a browser)
open http://localhost:3000/api/docs
```

If both work, the app is healthy. The Swagger UI is the easiest way to explore and try every endpoint.

### Quick end-to-end smoke test from `curl`

The service uses simple header-based auth: every protected request needs `X-Role` (one of `employee`, `manager`, `admin`, `hcm`) and, for routes that act on behalf of someone, `X-Actor-Id`.

```bash
# 1. HCM seeds Alice's balance via batch sync
curl -X POST http://localhost:3000/hcm/batch-sync \
  -H "X-Role: hcm" -H "Content-Type: application/json" \
  -d '{"batchId":"seed-1","generatedAt":"2026-04-25T12:00:00Z",
       "balances":[{"employeeId":"alice","locationId":"NYC","balance":10}]}'

# 2. Alice reads her balance
curl "http://localhost:3000/employees/alice/balances?locationId=NYC" \
  -H "X-Role: employee" -H "X-Actor-Id: alice"
# → {"employeeId":"alice","locationId":"NYC","settled":10,"pendingHolds":0,"available":10}

# 3. Alice submits a 2-day request
curl -X POST http://localhost:3000/requests \
  -H "X-Role: employee" -H "X-Actor-Id: alice" \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"alice","locationId":"NYC",
       "startDate":"2099-05-04","endDate":"2099-05-05"}'
# → {"id":"...","status":"PENDING_APPROVAL","days":2,...}

# 4. A manager approves it (manager cannot be the same person as the employee).
#    Replace <REQUEST_ID> with the id from step 3.
curl -X POST http://localhost:3000/requests/<REQUEST_ID>/approve \
  -H "X-Role: manager" -H "X-Actor-Id: mgr-1"
# → {"id":"...","status":"SYNCED",...}
```

> **Note:** step 4 makes a real HCM call. If you don't have a mock HCM running on `HCM_BASE_URL`, the request will fail. The test suite spins one up automatically — see *Testing* below.

## Testing

```bash
# Unit + integration tests (in-memory SQLite, real Express mock HCM)
npm test

# Same, with coverage
npm run test:cov

# End-to-end tests (full HTTP through the real API)
npm run test:e2e
```

The test suite is the most reliable way to exercise the service's behaviour without standing up a real HCM, because the mock HCM is started automatically and configured per test.

### What's covered

- **Unit / integration:** balance projection, ledger semantics, state machine transitions, mutex serialisation, working-day calculation, HCM client (retries, idempotency, verification), reconciliation logic. Real SQLite (`:memory:`) used wherever DB behaviour matters.
- **E2E:** full HTTP flows — submit → approve → SYNCED → ledger; reject and cancel paths; auth (missing / invalid / insufficient role); idempotency-key replay; whitelist rejecting unknown fields; repeated `batchId` is a no-op.

### Headline numbers

| Layer | Test count | Notes |
|---|---|---|
| Unit / integration (`npm test`) | **91** across 10 suites | In-memory SQLite + Express mock HCM |
| End-to-end (`npm run test:e2e`) | **15** across 2 suites | Full HTTP through `AppModule` |
| **Total** | **106** | |

Statement coverage on domain code (run `npm run test:cov`):

| Area | % Stmts | % Branch | % Lines |
|---|---|---|---|
| `src/lifecycle` (state machine, working days, lifecycle service) | 85 | 75 | 90 |
| `src/hcm/hcm-client.ts` | 94 | 76 | 95 |
| `src/reconciliation` | 88 | 81 | 89 |
| `src/ledger` (entity + service + enum) | 83 | 82 | 86 |
| `src/requests/requests.service.ts` | 100 | 70 | 100 |

Controllers and Nest module-bootstrap files show as uncovered in `npm run test:cov` because controllers are exercised by the e2e suite (which runs under a separate Jest config). The 25-scenario checklist below maps each named scenario to the file that proves it.

### Scenario checklist (mapped to test files)

The 25 named scenarios from TRD §11.3 — and their test locations:

| # | Scenario | File |
|---|---|---|
| 1 | Submit → approve → HCM confirm → SYNCED + ledger row | `src/lifecycle/request-lifecycle.service.spec.ts`, `test/api.e2e-spec.ts` |
| 2 | Manager rejects → REJECTED, no ledger | `src/lifecycle/request-lifecycle.service.spec.ts`, `test/api.e2e-spec.ts` |
| 3 | Employee cancels in PENDING_APPROVAL → no ledger | `src/lifecycle/request-lifecycle.service.spec.ts`, `test/api.e2e-spec.ts` |
| 4 | Employee cancels in SYNCED → compensating HCM call + refund row | `src/lifecycle/request-lifecycle.service.spec.ts` |
| 5 | Approve already-approved → 409 | `src/lifecycle/request-lifecycle.service.spec.ts` |
| 6 | Cancel after `start_date` → 422 | (covered indirectly via lifecycle guard; manual test path) |
| 7 | Any transition from a terminal state → 409 | `src/lifecycle/state-machine.spec.ts` |
| 8 | Two parallel submits, one succeeds | `src/lifecycle/request-lifecycle.service.spec.ts` |
| 9 | Same `Idempotency-Key` returns the same request | `src/lifecycle/request-lifecycle.service.spec.ts`, `test/api.e2e-spec.ts` |
| 10 | Approve twice in parallel → first wins, second 409 | (state machine + mutex; see scenarios 5 + 8) |
| 11 | HCM 4xx on deduction → FAILED | `src/lifecycle/request-lifecycle.service.spec.ts` |
| 12 | HCM 5xx once, succeeds on retry → SYNCED | `src/hcm/hcm-client.spec.ts`, `src/lifecycle/request-lifecycle.service.spec.ts` |
| 13 | HCM 5xx through all retries → FAILED | `src/hcm/hcm-client.spec.ts`, `src/lifecycle/request-lifecycle.service.spec.ts` |
| 14 | Lost response → retry with same key, no double-deduct | `src/hcm/hcm-client.spec.ts` |
| 15 | HCM silent-accept → verification flags it → FAILED | `src/hcm/hcm-client.spec.ts`, `src/lifecycle/request-lifecycle.service.spec.ts` |
| 16 | Batch with anniversary bonus (HCM > local) | `src/reconciliation/reconciliation.service.spec.ts` |
| 17 | Batch with drift (HCM < local) | `src/reconciliation/reconciliation.service.spec.ts` |
| 18 | Batch arrives during a SYNCED-mid-flight — no spurious correction | `src/reconciliation/reconciliation.service.spec.ts` |
| 19 | Repeated `batchId` is a no-op | `src/reconciliation/reconciliation.service.spec.ts`, `test/api.e2e-spec.ts` |
| 20 | Friday→Monday counts as 2 working days | `src/lifecycle/working-days.spec.ts` |
| 21 | All-weekend range rejected | `src/lifecycle/request-lifecycle.service.spec.ts`, `src/lifecycle/working-days.spec.ts` |
| 22 | Single Monday counts as 1 | `src/lifecycle/working-days.spec.ts` |
| 23 | Employee → `/approve` → 403 | `test/api.e2e-spec.ts` |
| 24 | Manager approves their own request → 403 | `src/lifecycle/request-lifecycle.service.spec.ts`, `test/api.e2e-spec.ts` |
| 25 | Missing or malformed role header → 401 | `test/api.e2e-spec.ts` |

## API reference

All endpoints live under the root path; `/health` and `/api/docs` are public, everything else needs `X-Role` and (where it acts on a person) `X-Actor-Id`.

### Public

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `GET` | `/api/docs` | Swagger UI |
| `GET` | `/api/docs-json` | Raw OpenAPI spec |

### Employee-facing (role: `employee`)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/employees/:id/balances?locationId=X` | Settled, pending holds, available |
| `GET` | `/employees/:id/requests?status=...` | Filterable history |
| `POST` | `/requests` | `Idempotency-Key` header recommended |
| `GET` | `/requests/:id` | Detail; employees scoped to their own |
| `POST` | `/requests/:id/cancel` | Allowed in non-terminal states with future `start_date` |

### Manager / admin

| Method | Path |
|---|---|
| `POST` | `/requests/:id/approve` |
| `POST` | `/requests/:id/reject` (body: `{ "reason": "..." }`) |
| `GET` | `/requests/:id/ledger` |

### HCM-inbound (role: `hcm`)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/hcm/batch-sync` | Idempotent on `batchId` |

## Project layout

```
src/
├── api/                     ApiModule that owns the /requests controller
├── auth/                    Header-based AuthGuard, Roles + Public decorators
├── balances/                BalanceService (settled - pendingHolds = available)
├── concurrency/             MutexRegistry (per (employee, location) lock)
├── config/                  Env-backed configuration loader
├── employees/               /employees controller (balances + requests)
├── hcm/                     HcmClient (outbound) + HcmWebhookController (inbound)
├── health/                  /health endpoint (public)
├── ledger/                  Append-only Ledger entity + projection
├── lifecycle/               StateMachine + RequestLifecycleService + working-days
├── reconciliation/          ProcessedBatch + ReconciliationService (grace window)
├── requests/                TimeOffRequest entity + RequestsController + DTOs
├── app.module.ts            Root module
└── main.ts                  Bootstrap (validation pipe, Swagger)

test/
├── api.e2e-spec.ts          Full HTTP e2e suite
├── app.e2e-spec.ts          Health smoke test
├── jest-e2e.json            Jest config for e2e
└── mock-hcm/                Express mock HCM server with configurable failures

docs/
└── TRD.md                   Technical Requirements Document
```

## Architecture (high-level)

See [`docs/TRD.md`](docs/TRD.md) for the full document. Summary of the load-bearing decisions:

- **Append-only ledger of deltas** (per `(employee, location)`) — settled balance is `SUM(delta)`. Pending holds live separately on the `requests` table. Available balance = settled − pending.
- **Eight-state request lifecycle** with explicit transitions: `PENDING_APPROVAL → APPROVED_SYNCING → SYNCED` happy path; `SYNC_RETRY` and `FAILED` for HCM failures; `REJECTED`, `CANCELLED`, `COMPLETED` terminal.
- **Idempotency keys** on every HCM write; same key safely retryable, including across process restarts (key is deterministic per request).
- **Per-request verification** after every HCM 2xx — looks up the deduction by idempotency key. Defends against HCM silently dropping a write.
- **Batch reconciliation** with an in-flight grace window so reconciliation never clobbers a sync that completed after the batch was generated.
- **Per-key in-process mutex** for concurrency on a single instance (Redis is the documented scaling path).

## Branching strategy

- `main` — release-ready
- `develop` — integration branch
- `feature/*` — one concern each, merged into `develop` via PR

Every feature merge is reviewable as its own PR on GitHub.
