# Project guide for coding agents

Read this file before changing the project. Keep the implementation status current after meaningful slices and explain changes to the user in plain language.

## Product and working style

Build the Rider Payout Dispute Desk for QuickDrop/ProcureYard. Riders send payout complaints one message at a time. The service should understand and retain context, inspect trip and payout records, explain outcomes, make only policy-approved payments, and send unclear or higher-risk cases to operations.

The user wants to build in small, reviewable slices. Explain each part simply and stop for review when asked. The current agreed stack is Node.js 24, TypeScript, Express, PostgreSQL, Docker Compose, and Groq. Keep payout calculations, eligibility, caps, and payment authorization deterministic; Groq handles understanding and wording only.

## Authoritative requirements

Read the relevant source files before changing behavior:

- `BRIEF.md` — product request and required features.
- `docs/policy.md` — payout rules.
- `SUBMISSION.md` — API response shapes and submission requirements.
- `data/README.md` and `data/conversations.json` — reference data and expected scenarios.
- `payswift/README.md` — sandbox API.

Required interface:

- `GET /health` — HTTP 200 when the service and database are ready.
- `POST /messages` — accepts `message_id`, `rider_id`, `text`, and timezone-aware `received_at`; returns at least `{"reply":"..."}`.
- `GET /trace/{rider_id}` — ordered trace steps with `at`, `type`, `name`, `input`, and `output`.
- `GET /ops/pending` — pending approvals and escalations.
- Swagger at `/docs` is kept for local API exploration.
- The complete assignment also requires an operations page, an evaluation command taking the service URL, Docker Compose, and GitHub Actions.

## Payout policy

- Completed trip: ₹25 base plus ₹6 per kilometre after the first 2 km; surge applies to the full fare; each trip rounds half-up to a whole rupee.
- Incentive: ₹150 for 12 or more completed trips in one IST calendar day.
- Rider cancellation penalty: ₹10. Customer cancellation: ₹0.
- A dispute must fall within the seven inclusive IST calendar dates ending on `received_at`'s IST date.
- Auto-pay at most ₹200 per dispute and once per rider per IST day. Larger or repeated amounts require operations approval. Never pay more than verified owed.
- PaySwift is the payment source of truth. PostgreSQL payment rows are audit copies.

## Current implementation status

The active implementation is TypeScript under `src/`. A local, Git-ignored snapshot of the prior Python source is kept under `.archive/python-stack/` for recovery; do not add or run it as a second backend.

- `src/domain/payouts.ts` — deterministic fare, IST dispute-window, trip and day assessments using decimal arithmetic.
- `src/infrastructure/reference-data/csv-loader.ts` — validates and loads the supplied CSVs, normalizes known rider ID variants, skips exact duplicate trips, and rejects conflicting duplicates.
- `src/infrastructure/database/db.ts` — PostgreSQL schema creation, connection pool, and repeatable CSV upserts.
- `src/infrastructure/llm/groq-client.ts` — strict structured extraction and reply drafting. It receives conversation context only, not payout records or payment tools. Deterministic filters check account identity, trip ID/date syntax, and unsafe replies.
- `src/application/messages.ts` — idempotent inbound-message processing, conversation-state persistence, trace creation, and retry behavior.
- `src/application/claims.ts` — rider/trip/payout lookups, seven-day IST eligibility, deterministic trip/day assessment, and outcome replies.
- `src/application/payments.ts`, `src/infrastructure/payswift/client.ts` — reconcile PaySwift's ledger, send only eligible deterministic shortfalls with stable idempotency keys, and save provider request/results as PostgreSQL audit rows.
- `src/application/traces.ts`, `src/application/ops.ts` — chronological trace, operations queue/conversation queries, and approve/reject actions.
- `src/templates/ops.html` — local operations review page for rider conversations, traces, and pending items.
- `src/app.ts`, `src/main.ts`, `src/api/openapi.ts` — Express routes, Swagger documentation, startup, reference import, and readiness.
- `evals/run.py` — black-box conversation evaluator; assertions use the public app API and PaySwift ledger only. Supports all scenarios or one isolated case via `--case`.
- `.github/workflows/ci.yml` — build on every push/PR and a clean Compose stack per conversation when the Groq secret is configured.
- `eval-results.json` — latest local run report, with isolation caveat.
- `Dockerfile`, `docker-compose.yml`, `package.json`, `tsconfig.json`, `.env.example` — TypeScript container and local configuration. Keep the assignment-provided `payswift` service unchanged. Never commit `.env` or a real Groq key.

Groq understanding and PaySwift payouts are both wired through. The default model is `qwen/qwen3.8-27b` because `openai/gpt-oss-20b` hit its 200,000 token daily cap and spends extra reasoning tokens. PaySwift's sandbox delays some creates by 8 seconds, rejects some with HTTP 503, and sometimes stores a payout then answers HTTP 504. The client waits 15 seconds, retries those responses with the same idempotency key, and checks the ledger before opening an approval. An isolated evaluator run on 2026-11-01 passed 24/24. That run is recorded in `eval-results.json`. Operations approve/reject in the sandbox was not part of that run.

### Remaining work

- Manually exercise operations approve/reject sandbox behavior. The page renders locally; those payment and rejection actions were not part of the 24/24 evaluator run.
- Add the GitHub Actions `GROQ_API_KEY` secret, export raw AI sessions to `ai-logs/`, and complete submission logistics. The README should remain at most one page.

## Code layout

- `src/api/` — Express routes and OpenAPI spec.
- `src/application/` — request use cases and orchestration.
- `src/domain/` — deterministic payout rules.
- `src/infrastructure/database/` — PostgreSQL schema and reference import.
- `src/infrastructure/reference-data/` — CSV parsing and validation.
- `src/infrastructure/llm/` — Groq integration.
- `src/infrastructure/payswift/` — future PaySwift client.
- `src/templates/` — operations UI.

## Conventions

- Preserve original assignment data and the provided PaySwift service.
- Do not commit or push unless the user asks.
- Do not expose secrets. Keep all required configuration in `.env.example`.
- Keep changes in small reviewable slices and make clear what is still incomplete.
