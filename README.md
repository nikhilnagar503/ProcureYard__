# Rider Payout Dispute Desk

QuickDrop’s service receives rider payout complaints, keeps conversation context, checks the supplied trip and payout records, and either explains the result, pays an eligible shortfall through PaySwift, or sends the case to operations.

## Run locally

Install Docker Desktop, copy `.env.example` to `.env`, and set `GROQ_API_KEY` plus a private `OPS_API_KEY` (at least 16 characters). From the repository root:

```sh
docker compose up --build
```

Open the rider/API explorer at http://localhost:8000/docs, operations page at http://localhost:8000/ops, and PaySwift sandbox at http://localhost:8081. Run all supplied sample conversations with:

```sh
python3 evals/run.py http://localhost:8000
```

The full run builds and restarts the local Compose stack for each conversation, clearing its Postgres volume and PaySwift sandbox so one case cannot affect another. It leaves the stack stopped when finished and writes failures to `eval-results.json`; allow several minutes for all 24 cases and Groq cooldowns. This clears local development data. To run one sample against an already-running stack, use `python3 evals/run.py http://localhost:8000 --case 1` (case 1–24). Evaluation results are read only through public service routes and the PaySwift ledger. GitHub Actions runs each case in its own clean Compose stack.

## Architecture

Docker Compose runs the Express app, PostgreSQL, and the supplied PaySwift sandbox. A complaint enters `POST /messages`. The app saves the conversation, asks Groq only to identify the issue and draft wording, then runs deterministic policy code over the trip and payout rows. An eligible shortfall is sent to PaySwift with a stable idempotency key. PostgreSQL keeps the conversation, the trace, and an audit copy of the payment. PaySwift remains the payment source of truth.

Groq does not receive payout records or payment tools. Fare, the seven inclusive IST dates, the daily incentive, cancellation penalties, the ₹200 auto-pay cap, and one automatic payout per rider per IST day live in `src/domain/payouts.ts`. A larger amount, a second payout on the same IST day, or an uncertain provider result is queued for operations. Approve and reject on `/ops` reuse the stored verified amount and never take an amount from the operator. The included PaySwift service is a sandbox, not a real transfer provider.

## Evaluation

An isolated run on 1 November 2026 passed 24/24. Each conversation used a fresh Compose stack. Run it with:

```sh
python3 evals/run.py http://localhost:8000
```

The report is [`eval-results.json`](eval-results.json). The operations page at http://localhost:8000/ops can approve or reject a pending item; that action was not part of the 24-case run. Add the GitHub secret `GROQ_API_KEY` so CI runs the same cases.

## Before the email reply

Put one unedited raw export per AI session in `ai-logs/` (not summaries or screenshots). Cursor: chat menu (…) → Export Chat. Other tools are listed in [`SUBMISSION.md`](SUBMISSION.md). Skim exports for keys, rotate any key that appears, and never add `.env`. Then reply to the assignment email with the private repository link.
