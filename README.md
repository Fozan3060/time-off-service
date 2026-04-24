# Time-Off Microservice

A microservice for managing the lifecycle of employee time-off requests, synchronising balances with an external HCM (Human Capital Management) system that acts as the source of truth.

## Status

In progress.

## Stack

- **Framework:** NestJS
- **Database:** SQLite
- **Runtime:** Node.js
- **Testing:** Jest (unit + integration)

## Setup

_TBD — will be filled in once the project is scaffolded._

## Run

_TBD._

## Tests

_TBD._

## Architecture

See [`docs/TRD.md`](docs/TRD.md) for the full Technical Requirements Document covering:

- Problem statement and constraints
- Data model (ledger + requests)
- Request lifecycle state machine
- HCM integration (idempotency, retry, batch reconciliation)
- API surface
- Concurrency strategy
- Test strategy
- Alternatives considered

## Project Layout

_TBD — populated after scaffolding._

## Branching Strategy

- `master` — stable, release-ready
- `develop` — integration branch
- `feature/*` — feature branches, merged into `develop`
