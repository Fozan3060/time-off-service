# Time-Off Microservice

Backend microservice for managing the lifecycle of employee time-off requests while keeping leave balances in sync with an external HCM (Human Capital Management) system.

Full design and rationale: [`docs/TRD.md`](docs/TRD.md).

## Stack

- **Runtime:** Node.js 22+
- **Framework:** NestJS 11
- **Database:** SQLite via TypeORM
- **API docs:** Swagger / OpenAPI (`@nestjs/swagger`)
- **Testing:** Jest (unit) + Supertest (e2e) + real mock HCM server (Express)

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy the environment template and adjust if needed
cp .env.example .env
```

The `.env.example` contains sensible defaults for local development. Most people won't need to change anything.

## Running

```bash
# Development (watches files, restarts on change)
npm run start:dev

# Production-style (requires a prior build)
npm run build
npm run start:prod
```

Once running, the service listens on `http://localhost:3000` (configurable via `PORT`).

- **Health check:** `GET http://localhost:3000/health`
- **API docs:** `http://localhost:3000/api/docs`

## Testing

```bash
# Unit tests
npm test

# Unit tests with coverage
npm run test:cov

# End-to-end tests
npm run test:e2e
```

Unit tests live next to the code they test (`*.spec.ts`). End-to-end tests live under `test/`.

## Project layout

```
src/
├── app.module.ts           Root module (wires config, TypeORM, feature modules)
├── main.ts                 Bootstraps the app, validation pipe, Swagger
├── config/
│   └── configuration.ts    Typed env-backed configuration loader
└── health/
    ├── health.module.ts
    ├── health.controller.ts
    └── health.controller.spec.ts

test/
├── app.e2e-spec.ts         End-to-end smoke test
└── jest-e2e.json           Jest config for e2e runs

docs/
└── TRD.md                  Technical Requirements Document
```

More modules will be added in subsequent feature branches: data model (`requests`, `ledger`), state machine, HCM client, reconciliation service, the mock HCM server, and the rest of the test suite.

## Architecture

See [`docs/TRD.md`](docs/TRD.md) for the full TRD. Highlights:

- **Data model:** append-only ledger of balance deltas plus a mutable `requests` table for pending lifecycle state.
- **State machine:** `PENDING_APPROVAL → APPROVED_SYNCING → SYNCED` (with retry and failure branches); cancellation allowed from non-terminal states with leave date still in the future.
- **HCM integration:** idempotency keys on every write, exponential retry on transient failures, per-request verification after a 2xx, batch reconciliation for independent HCM changes.
- **Concurrency:** in-process mutex keyed on `(employeeId, locationId)`; Redis is the scaling path.
- **API style:** REST with action endpoints (`POST /requests/:id/approve` rather than `PATCH`).

## Branching strategy

- `main` — release-ready
- `develop` — integration branch, all feature work lands here first
- `feature/*` — feature branches, one concern per branch, merged into `develop` via PR

## Test scenarios

A mapped checklist of the 25 scenarios from TRD §11.3 will be added here once the corresponding test files exist.
