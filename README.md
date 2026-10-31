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

## Design and assumptions

Node 24, TypeScript, Express, PostgreSQL, Docker Compose and Groq. Groq extracts the issue, trip/date details and missing information, then drafts wording; deterministic code calculates policy fare, the seven-day IST eligibility window, the ₹200 automatic cap, one automatic payout per rider per IST day, and the verified payable amount. PaySwift is the payment source of truth; PostgreSQL keeps audit copies. Stable idempotency keys are reused on retries. Operations approval uses only the stored, verified claim amount and never accepts an operator-entered amount. The included PaySwift service is a sandbox, not a real transfer provider.

## Evaluation

An isolated run on 1 November 2026 passed 24/24. Each conversation used a fresh Compose stack. Run it with:

```sh
python3 evals/run.py http://localhost:8000
```

The report is [`eval-results.json`](eval-results.json). The operations page at http://localhost:8000/ops can approve or reject a pending item; that action was not part of the 24-case run. Add the GitHub secret `GROQ_API_KEY` so CI runs the same cases.

## Before the email reply

Put one unedited raw export per AI session in `ai-logs/` (not summaries or screenshots). Cursor: chat menu (…) → Export Chat. Other tools are listed in [`SUBMISSION.md`](SUBMISSION.md). Skim exports for keys, rotate any key that appears, and never add `.env`. Then reply to the assignment email with the private repository link.
