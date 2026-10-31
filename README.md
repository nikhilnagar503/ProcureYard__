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

`POST /messages` validates vendor messages, deduplicates retries by `message_id`, sends rider wording and safe issue context to Groq, and stores the extracted issue. Application code then looks up the rider, trips, and payout lines in PostgreSQL and deterministically assesses a trip or IST-day claim inside the seven-day window. Replies explain a verified shortfall, no shortfall, or why the available records are unclear. Groq does not receive payout evidence and does not calculate or authorize money. This slice does not call PaySwift or move funds.

`GET /trace/{rider_id}` returns ordered message, Groq, rider/trip/payout lookup, deterministic assessment, context-update, reply, and error events. `GET /ops/pending` lists operations items. The payout rules in `src/domain/payouts.ts` are used for this assessment; approval limits and payment handling remain future work.

## Remaining work

Add runtime verification for deterministic trip/day claim assessments and multi-turn context, handle payment limits and operations approvals, reconcile and pay through PaySwift, build the operations page, add the evaluation runner and CI, and record evaluation results before submission. The basic Groq message-understanding path has been manually verified; this new database investigation slice has compiled but has not yet been exercised against the running app.
