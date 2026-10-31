# Rider Payout Dispute Desk

ProcureYard take-home project for QuickDrop. This service receives rider payout complaints, keeps conversation context, and will eventually investigate records and route or pay verified shortfalls.

## Stack and run

- Node.js 24 + TypeScript + Express
- PostgreSQL accessed with the `pg` driver
- Groq for language understanding and reply wording only
- Docker Compose starts the app, database, and provided PaySwift sandbox

On first setup, copy `.env.example` to `.env` and add your own `GROQ_API_KEY`. From the project folder, run:

```sh
docker compose up --build
```

Open Swagger at http://localhost:8000/docs. The app and PaySwift health routes are http://localhost:8000/health and http://localhost:8081/health.

## Current agent design

`POST /messages` validates vendor messages, deduplicates retries by `message_id`, sends the message plus recent context to Groq, stores structured issue details in PostgreSQL, and returns a short reply. The model extracts issue type, trip IDs, dates, and missing details. It does not receive payout records or payment tools. Deterministic application code validates the model's proposed IDs and dates and blocks cross-rider requests and payment promises.

`GET /trace/{rider_id}` returns ordered message, Groq, context-update, reply, and error events. `GET /ops/pending` lists operations items. The payout rules are implemented as deterministic functions in `src/domain/payouts.ts`, but the message agent does not call them yet.

## Remaining work

Connect message understanding to trip and payout records, apply the seven-day IST policy, handle operations approvals, reconcile and pay through PaySwift, build the operations page, add the evaluation runner and CI, and record evaluation results before submission. The basic Groq message-understanding path has been manually verified; multi-turn context and end-to-end payout handling remain to be reviewed and built.
