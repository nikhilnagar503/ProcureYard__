# ProcureYard Rider Payout Dispute Desk — Project Guide

This guide explains the project in plain language: what it is meant to do, how the current code is organized, how a rider message is handled, and what is still unfinished.

## What the project is

QuickDrop riders send messages when they believe a trip or daily payout is wrong. The service receives one message at a time, keeps enough context to understand follow-ups, checks trip and payout records, and explains the result. Verified small claims can be paid through PaySwift; unclear or higher-risk claims are routed to operations.

The long-term agent must never let the language model decide how much money is owed or authorize a payment. Groq helps interpret Hindi, Hinglish, and English messages. TypeScript code and the supplied records determine the payout result.

## Current implementation boundary

The current code can understand a complaint, look up a specific trip or payout day, calculate the policy amount, compare it with imported payout lines, explain the result, and send eligible shortfalls through PaySwift.

**Payments use PaySwift as the source of truth.** Before paying an eligible claim, the app reads that rider's PaySwift ledger and reconciles its PostgreSQL audit rows. Only deterministic verified shortfalls within policy are sent. Large, repeat, unclear, suspicious, and daily-limit cases are not automatically paid. The TypeScript build passes; this new PaySwift/PostgreSQL Docker flow still needs runtime review.

## How one message flows through the service

1. The vendor sends `message_id`, `rider_id`, `text`, and timezone-aware `received_at` to `POST /messages`; the app immediately adds a message-received trace event.
2. The app validates the request and saves it in PostgreSQL. `message_id` makes retries safe: an already-completed request returns its saved reply, and reusing an ID with different content returns HTTP 409.
3. The app loads the rider's open issue details and recent rider messages. Groq proposes the issue type, trip IDs, dates, missing details, and a draft reply. That extraction is traced before database lookups. Groq does not receive payout records or payment tools.
4. If the model has enough details, deterministic code checks the rider and queries trips and payout lines in PostgreSQL, recording each lookup. The code—not Groq—applies the payout formula and seven-day IST window and records the policy result.
5. The app reads PaySwift's ledger and reconciles payouts into PostgreSQL audit rows. Deterministic code routes unclear and suspicious claims to escalation; large and repeat claims, and claims after the daily slot is used, go to approval. Provider results and errors are traced as they occur.
6. For a first-time verified shortfall up to ₹200, the app reserves the rider's daily slot and calls PaySwift with a stable idempotency key. It records the request and provider response in `payment_records`; it reports success only for a final success status.
7. The app records the final rider reply after the preceding receipt, extraction, lookup, policy, provider, and error events, then returns `{"reply":"..."}`.

When the trip/date is missing, the app asks the rider for it. If a record is missing, belongs to another rider, conflicts with the supplied date, or is outside the review window, the app says it could not verify the claim. It does not treat unclear information as proof that money is owed.

## Payout rules implemented in deterministic code

- A completed trip earns ₹25 base plus ₹6 for each kilometre beyond the first 2 km. Apply the surge multiplier to the full fare and round each trip to the nearest rupee, with 0.5 rounding up.
- A rider earns a ₹150 daily incentive after 12 or more completed trips in one IST calendar day.
- A rider cancellation has a ₹10 penalty. A customer cancellation earns ₹0.
- A dispute is in scope for the seven inclusive IST calendar dates ending on the message's `received_at` date.
- The investigation compares policy amount with imported historical payout lines. A positive difference is reported as a verified shortfall; zero or a negative difference means no additional amount is due.

The payout CSV is used to calculate what policy says the rider should have earned. PaySwift is used to check transferred money and previous payouts. PostgreSQL `payment_records` is an audit copy, not the payment source of truth.

## PaySwift safety and failure handling

- The amount is checked immediately before the request: it must be a positive integer, no more than ₹200, and no greater than the deterministic verified shortfall. Only the `auto_payment_eligible` path can call PaySwift.
- The `Idempotency-Key` is stable for the rider and claim. A timeout, rate limit, or server error can be retried once with that same key, so a provider-accepted first attempt cannot become a second transfer.
- PaySwift's ledger is read before routing a verified claim. Provider payouts are copied/reconciled into local audit rows. A ledger payout with no timestamp is conservatively treated as activity today for the once-per-day cap.
- A final success is recorded with the provider payout ID and status. A confirmed rejection is recorded as failed, releases the daily slot, and creates an operations item.
- If the result is ambiguous (timeout after retry, HTTP 409, malformed response, or non-final status), the record is `unknown`, the daily slot stays reserved, and operations must reconcile the ledger before retrying. The rider is not told that it definitely paid or definitely failed.
- If the ledger cannot be read, automatic payment is blocked and the verified claim is routed to operations. There is no automatic/background retry worker in this slice.

## Main folders and files

- `src/app.ts` — Express routes: health, message, trace, operations APIs and page; Swagger is served at `/docs`.
- `src/main.ts` — starts PostgreSQL, creates the schema, imports the CSV data, and starts the server.
- `src/application/messages.ts` — request idempotency, conversation context, Groq orchestration, trace persistence, and response handling.
- `src/application/claims.ts` — rider/trip/payout lookups, seven-day check, trip/day assessment, and deterministic outcome replies. It does not call PaySwift.
- `src/application/decisions.ts` — deterministic unclear/suspicious escalation and large/repeat/daily-limit approval routing; records claim evidence and reserves the daily payment slot.
- `src/application/payments.ts` — reconciles the PaySwift ledger with local audit rows and sends eligible capped payments.
- `src/infrastructure/payswift/client.ts` — HTTP client for PaySwift's payout ledger and idempotent payout endpoint.
- `src/application/traces.ts` — reads a rider's ordered trace events.
- `src/application/ops.ts` — conversations, traces, pending items, and approve/reject actions. Approval uses the stored deterministic evidence and the same claim idempotency key as automatic payout.
- `src/templates/ops.html` — local operations page with review queue, conversations, trace details, and confirmation prompts.
- `src/domain/payouts.ts` — reusable fare formulas, IST date-window check, and trip/day assessments.
- `src/infrastructure/llm/groq-client.ts` — asks Groq for structured issue understanding and wording, then validates and filters its result.
- `src/infrastructure/database/db.ts` — PostgreSQL pool, table definitions, and repeatable CSV imports.
- `src/infrastructure/reference-data/csv-loader.ts` — validates the supplied rider, trip, and payout CSVs.
- `data/` — assignment-provided riders, trips, payout lines, and sample conversations.
- `payswift/` — assignment-provided payment sandbox. Its service files remain unchanged.
- `docker-compose.yml`, `Dockerfile`, `.env.example` — local services and configuration template.

## APIs available now

- `GET /health` — checks that the app can reach PostgreSQL.
- `POST /messages` — receives a rider message and returns a reply.
- `GET /trace/{rider_id}` — returns message, model, database lookup, decision, context, reply, and error events in time order.
- `GET /ops/pending` — lists pending approvals/escalations, their reason, and verified claim details.
- `GET /ops` — local operations page.
- `GET /ops/conversations` and `GET /ops/conversations/{rider_id}` — recent riders and their message history/context.
- `POST /ops/{id}/approve` — requires `Authorization: Bearer <OPS_API_KEY>` and a reviewer name. It reads the verified amount from the stored claim, confirms its payout breakdown, reconciles PaySwift first, then requests exactly that amount with the same stable claim idempotency key. It never accepts an amount override from the operator.
- `POST /ops/{id}/reject` — requires the same key and records the reviewer and rejection note in the trace.
- `GET /docs` — interactive Swagger page for trying the APIs.

Set a private `OPS_API_KEY` of at least 16 characters in `.env` before using approve/reject. Read-only queue and conversation views are available without the key. The page asks for the key and reviewer name and keeps them in the browser tab's session storage. Approval shows a confirmation prompt; a confirmed provider result resolves the item, a confirmed provider rejection returns it to the queue, and an uncertain result remains approved with the same idempotency key for safe ledger reconciliation/retry.

Trace records are written at each processing stage, so `/trace/{rider_id}` and the operations page show message receipt, model extraction, data lookups, policy decision, PaySwift reconciliation/request/result, final reply, and processing errors in time order. Operations approve/reject events are also included.

Trace event names added by the investigation include `rider_record_lookup`, `trip_record_lookup`, `trip_payout_lookup`, `day_trip_lookup`, `day_payout_lookup`, and `payout_claim_assessed`.

Decision traces use `claim_payment_path_selected`, `payswift_ledger_reconciled`, and payout request/result events. Approval/escalation records carry a stable rider/claim fingerprint to avoid duplicate pending records; `claim_decisions` records repeats. Automatic payment cannot exceed the net verified shortfall or ₹200. A unique rider/IST-date slot is reserved atomically before an automatic PaySwift request. Operations approval can pay only the exact already-verified claim amount (subject to PaySwift's ₹10,000 API limit); it uses the same claim fingerprint and idempotency key. Reconciled ledger payouts and active local payment records block duplicate payment requests.

### Examples that enter each decision path

- **Unclear → escalation:** Rider `R003` claims trip `T000000` on a date in the review window, but that trip ID has no matching trip record. The escalation keeps the missing-record reason and any lookup evidence; verified owed is ₹0.
- **Suspicious → escalation:** The supplied sample has rider `R021` report trip `T482410`; the trip CSV links `T482410` to `R030`. The account/ownership mismatch is escalated and no amount is authorized.
- **Large → approval:** The supplied `R016` sample expects ₹425 for the Sep 19 day-level claim. If the deterministic assessment confirms ₹425 net owed, it creates a pending approval for ₹425 because that exceeds ₹200.
- **Repeat → approval:** `R003` submits the same trip/date claim for `T926334` again in a new message after its first decision. The stable fingerprint matches, so it needs operations approval even if the first decision was eligible for automatic payment.
- **Daily limit → approval:** The supplied `R027` sample contains separate verified shortfalls for Sep 20 and Sep 21 in one message. At most one can reserve the current processing day's IST automatic-payment slot; the other enters approval. The sample expects ₹15 and ₹10, with either claim allowed to be selected first.
- **Eligible → PaySwift:** A first-time verified `R003` claim for `T926334` has a ₹25 shortfall. If PaySwift confirms a final success status, the rider's reply includes the provider payout ID. Run-time confirmation against the sandbox is still needed.

## Run it locally

1. Start Docker Desktop and wait for its engine to be ready.
2. In the project folder, copy `.env.example` to `.env` and add your own `GROQ_API_KEY` to `.env`. Do not paste the real key into Swagger, Notion, or Git.
3. Start or rebuild the app and its database:

   ```sh
   docker compose up -d --build app
   ```

4. Open `http://localhost:8000/docs`. Compose connects to PaySwift using `http://payswift:8081`; when running Node directly on your computer, `.env` uses `http://localhost:8081`. Keep Docker Desktop running while using the app. Stop the containers with `docker compose down`.

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

A later two-complaint message returned Groq's `json_validate_failed` 400 before claim lookup. The client now allows a larger completion budget and retries that specific provider error once in JSON-object mode. The response still passes the same strict local Zod validation and deterministic account checks before use. Groq's docs describe JSON-object mode as syntax-only, so local schema validation remains required. The TypeScript build and a mocked-HTTP fallback check both pass; the live two-complaint request still needs to be retried after rebuilding the container.

## What remains

- Rebuild and exercise trip/day, no-shortfall, missing/out-of-window, suspicious, large, repeat, and same-IST-day paths in Swagger and the trace.
- Verify that a follow-up message updates the same conversation context. Polish the current reply wording, which can repeat a question in Hinglish and English.
- Rejection and daily-limit payment scenarios still need manual verification in Swagger and traces.
- Add the required evaluation runner, GitHub Actions, evaluation results, and submission evidence.
- Rebuild the Docker image and manually exercise the new operations page, approve/reject actions, successful provider confirmation, and ambiguous retry/reconciliation. The code has only been TypeScript-compiled so far; no operations action has been run.

## Current repository status

On 2026-10-31, local Docker checks confirmed two sandbox payouts: rider `R035` received ₹25 for trip `T980582`, and rider `R033` received ₹91 for trip `T206956`. PaySwift returned `processed` with a payout ID for each; PostgreSQL audit rows matched, both daily slots became `consumed`, and the repeated R035 claim went to operations without a second payout. The first R035 response exposed that the client did not recognize PaySwift's `data` envelope and `processed` status; after fixing both, ledger reconciliation recovered the payout, and replaying the original `message_id` returned its stored confirmation.

A separate-payment-within-the-same-day check was attempted for R035, but Groq attached the new trip complaint to the already-paid issue. That message did not reach the daily-limit decision path, so the one-per-day payment limit still needs a clean runtime test. Rejection/provider-outage behavior also remains to be checked. Changes remain local and uncommitted.
