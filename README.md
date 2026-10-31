# Rider Payout Dispute Desk

ProcureYard take-home project for QuickDrop. This service receives rider payout complaints, keeps conversation context, checks trip and payout records, and routes or pays verified shortfalls.

## Stack and run

- Node.js 24 + TypeScript + Express
- PostgreSQL accessed with the `pg` driver
- Groq for language understanding and reply wording only
- Docker Compose starts the app, database, and provided PaySwift sandbox

On first setup, copy `.env.example` to `.env`, then set `GROQ_API_KEY` and a private `OPS_API_KEY` (at least 16 characters). From the project folder, run:

```sh
docker compose up --build
```

Open the operations page at http://localhost:8000/ops or Swagger at http://localhost:8000/docs. The app and PaySwift health routes are http://localhost:8000/health and http://localhost:8081/health.

## Current agent design

`POST /messages` validates and deduplicates vendor messages, uses Groq only to understand rider wording, and checks trip/payout data deterministically. Only a verified shortfall up to ₹200 can be paid automatically, once per rider per IST day. Before paying, the app reads PaySwift's ledger and reconciles it with PostgreSQL audit rows. It sends a stable `Idempotency-Key` and saves the request/provider response. Large, repeat, unclear, and suspicious cases wait for operations. Groq never sees payout evidence or authorizes money.

`GET /trace/{rider_id}` returns chronologically written receipt, extraction, lookup, policy, PaySwift, reply, and error events. `/ops` shows conversations, traces, and review items. Approve/reject actions require the local operations key. An approval reads and validates the stored verified amount; operators cannot change it. The same claim idempotency key is used if PaySwift must be safely retried. Confirmed rejection returns the item to the queue; uncertain status keeps it approved for ledger reconciliation.

## Remaining work

PaySwift success, ambiguous-result reconciliation, idempotent message retry, and repeat-claim handling have been manually exercised against the local sandbox. This operations page and approval/rejection workflow compile but have not yet been exercised at runtime. Evaluation tooling, GitHub Actions, and submission evidence remain unfinished.
