# ProcureYard Rider Payout Dispute Desk — Project Guide

This guide explains the project in plain language: what it is meant to do, how the current code is organized, how a rider message is handled, and what is still unfinished.

## What the project is

QuickDrop riders send messages when they believe a trip or daily payout is wrong. The service receives one message at a time, keeps enough context to understand follow-ups, checks the rider's trip and historical payout records, and explains what those records show. Later slices will send eligible payments through PaySwift and route uncertain or higher-risk claims to operations.

The long-term agent must never let the language model decide how much money is owed or authorize a payment. Groq helps interpret Hindi, Hinglish, and English messages. TypeScript code and the supplied records determine the payout result.

## Current implementation boundary

The current code can understand a complaint, look up a specific trip or a payout day, calculate the policy amount, compare it with imported payout lines, and explain a shortfall or no additional amount due. It can also say when it cannot verify a claim from the available information.

**No payment is made in this slice.** The new trip/day investigation has compiled, but has not yet been tested against the running Docker app. The basic Groq follow-up flow was manually tested before this investigation slice was added. No automated tests have been run.

## How one message flows through the service

1. The vendor sends `message_id`, `rider_id`, `text`, and timezone-aware `received_at` to `POST /messages`.
2. The app validates the request and saves it in PostgreSQL. `message_id` makes retries safe: an already-completed request returns its saved reply, and reusing an ID with different content returns HTTP 409.
3. The app loads the rider's open issue details and recent rider messages. Groq proposes the issue type, trip IDs, dates, missing details, and a draft reply. It does not receive payout records or payment tools.
4. If the model has enough details, deterministic code checks the rider and queries trips and payout lines in PostgreSQL. The code—not Groq—applies the payout formula and seven-day IST window.
5. The app stores the issue context and investigation result, records the lookups and decision in `trace_events`, then returns `{"reply":"..."}`.

When the trip/date is missing, the app asks the rider for it. If a record is missing, belongs to another rider, conflicts with the supplied date, or is outside the review window, the app says it could not verify the claim. It does not treat unclear information as proof that money is owed.

## Payout rules implemented in deterministic code

- A completed trip earns ₹25 base plus ₹6 for each kilometre beyond the first 2 km. Apply the surge multiplier to the full fare and round each trip to the nearest rupee, with 0.5 rounding up.
- A rider earns a ₹150 daily incentive after 12 or more completed trips in one IST calendar day.
- A rider cancellation has a ₹10 penalty. A customer cancellation earns ₹0.
- A dispute is in scope for the seven inclusive IST calendar dates ending on the message's `received_at` date.
- The investigation compares policy amount with imported historical payout lines. A positive difference is reported as a verified shortfall; zero or a negative difference means no additional amount is due.

The current investigation reply reports the result but explicitly says no payment was made. The imported payout CSV is historical data; PaySwift has not yet been integrated as the payment source of truth.

## Main folders and files

- `src/app.ts` — Express routes: health, message, trace, and pending-operations APIs; Swagger is served at `/docs`.
- `src/main.ts` — starts PostgreSQL, creates the schema, imports the CSV data, and starts the server.
- `src/application/messages.ts` — request idempotency, conversation context, Groq orchestration, trace persistence, and response handling.
- `src/application/claims.ts` — rider/trip/payout lookups, seven-day check, trip/day assessment, and deterministic outcome replies. It does not call PaySwift.
- `src/application/traces.ts` — reads a rider's ordered trace events.
- `src/application/ops.ts` — reads pending operations items; creating and resolving those items is still future work.
- `src/domain/payouts.ts` — reusable fare formulas, IST date-window check, and trip/day assessments.
- `src/infrastructure/llm/groq-client.ts` — asks Groq for structured issue understanding and wording, then validates and filters its result.
- `src/infrastructure/database/db.ts` — PostgreSQL pool, table definitions, and repeatable CSV imports.
- `src/infrastructure/reference-data/csv-loader.ts` — validates the supplied rider, trip, and payout CSVs.
- `data/` — assignment-provided riders, trips, payout lines, and sample conversations.
- `payswift/` — assignment-provided payment sandbox. Keep its service unchanged; this slice does not call it.
- `docker-compose.yml`, `Dockerfile`, `.env.example` — local services and configuration template.

## APIs available now

- `GET /health` — checks that the app can reach PostgreSQL.
- `POST /messages` — receives a rider message and returns a reply.
- `GET /trace/{rider_id}` — returns message, model, database lookup, decision, context, reply, and error events in time order.
- `GET /ops/pending` — lists pending operations rows. The current message flow does not create approval or escalation rows yet.
- `GET /docs` — interactive Swagger page for trying the APIs.

Trace event names added by the investigation include `rider_record_lookup`, `trip_record_lookup`, `trip_payout_lookup`, `day_trip_lookup`, `day_payout_lookup`, and `payout_claim_assessed`.

## Run it locally

1. Start Docker Desktop and wait for its engine to be ready.
2. In the project folder, copy `.env.example` to `.env` and add your own `GROQ_API_KEY` to `.env`. Do not paste the real key into Swagger, Notion, or Git.
3. Start or rebuild the app and its database:

   ```sh
   docker compose up -d --build app
   ```

4. Open `http://localhost:8000/docs`. Keep Docker Desktop running while using the app. Stop the containers with `docker compose down`.

For the full stack, including the provided PaySwift sandbox, use `docker compose up --build`.

## Example requests to try after rebuilding

Use new message IDs when testing. The example IDs below are samples; use a different ID if you already sent one.

### Specific-trip complaint

```json
{
  "message_id": "guide-trip-check-001",
  "rider_id": "R003",
  "text": "Bhai order T926334 ka surge nahi mila, 20 tarikh wala",
  "received_at": "2026-09-22T09:05:00+05:30"
}
```

The service should identify the trip/date, check the rider and payout records, then explain the deterministic comparison. This investigation does not pay the shortfall.

### Day-level complaint

```json
{
  "message_id": "guide-day-check-001",
  "rider_id": "R005",
  "text": "kal ka payout kam aaya hai. 12 se zyada order kiye the maine",
  "received_at": "2026-09-22T09:20:00+05:30"
}
```

This asks the service to resolve “yesterday” to an IST date, total that rider's trips and payout lines for the day, and apply the daily incentive rule. Review the outcome and trace rather than assuming the claim is owed.

After either request, inspect `GET /trace/R003` or `GET /trace/R005` to see which records and decisions the app used.

## Groq timeout problem and fix

During the first manual message tests, Swagger returned a generic 503. Checking `Boolean(process.env.GROQ_API_KEY)` inside the app showed `true`, but this only proved a value was present; it did not prove Groq accepted it. Safe diagnostic logs showed `Request timed out.`

The app setting was `GROQ_TIMEOUT_SECONDS=7`, but the Groq JavaScript SDK expects its `timeout` option in milliseconds. The app had passed `7` directly, so the timeout was 7 milliseconds. The code now converts seconds to milliseconds (`timeoutSeconds * 1000`). After rebuilding, the user confirmed that `/messages` reached Groq and returned a follow-up asking for the missing trip ID and date. The troubleshooting took multiple log checks and rebuild/retry cycles because the initial 503 response hid the underlying cause.

## What remains

- Rebuild and run the new claim investigation locally; review trip-level, day-level, no-shortfall, missing/mismatched-record, and out-of-window cases in Swagger and the trace.
- Verify that a follow-up message updates the same conversation context. Polish the current reply wording, which can repeat a question in Hinglish and English.
- Enforce the ₹200-per-dispute and one-auto-payment-per-rider-per-IST-day limits; route large, repeated, or unclear claims to operations.
- Integrate PaySwift ledger reconciliation and idempotent payment requests. Keep PostgreSQL payment records as audit copies.
- Build the operations review page and approve/reject flow.
- Add the required evaluation runner, GitHub Actions, evaluation results, and submission evidence.

## Current repository status

The basic Groq follow-up flow was manually confirmed. The TypeScript build passes with the new claim investigation, but that flow has not yet been exercised in the running app. This guide and the claim changes are local, uncommitted changes on top of the previously pushed project commit.
