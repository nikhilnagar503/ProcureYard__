import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ClaimOutcome } from "./claims.js";
import { createPendingOpsItem, DecisionEvent } from "./decisions.js";
import { PaySwiftClient, PaySwiftError, PaySwiftPayout } from "../infrastructure/payswift/client.js";

const CONFIRMED_STATUSES = new Set(["succeeded", "paid", "processed", "completed", "success"]);
const REJECTED_STATUSES = new Set(["failed", "rejected", "cancelled", "canceled", "error"]);
const ACTIVE_STATUSES = new Set(["reserved", "processing", "unknown", "succeeded", "paid", "processed", "completed"]);

export async function hasUnresolvedPaySwiftPayment(pool: Pool, riderId: string): Promise<boolean> {
  const result = await pool.query<{ found: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM payment_records
      WHERE rider_id = $1 AND lower(status) IN ('unknown', 'processing')) AS found`,
    [riderId],
  );
  return result.rows[0]?.found ?? false;
}

function todayIst(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function providerSuccess(payout: PaySwiftPayout): boolean {
  return CONFIRMED_STATUSES.has(payout.status.toLowerCase());
}

export async function reconcilePaySwiftLedger(
  pool: Pool,
  riderId: string,
  client: PaySwiftClient,
): Promise<{ payouts: PaySwiftPayout[]; events: DecisionEvent[] }> {
  const payouts = await client.listPayouts(riderId);
  const events: DecisionEvent[] = [];
  const seenIds = new Set(payouts.map((payout) => payout.payout_id));
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const payout of payouts) {
      if (payout.rider_id !== riderId) {
        throw new PaySwiftError("PaySwift returned a payout for a different rider.", null, false, true);
      }
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM payment_records
         WHERE payswift_payout_id = $1 OR reference = $2 LIMIT 1`,
        [payout.payout_id, payout.reference],
      );
      if (existing.rows[0]) {
        await db.query(
          `UPDATE payment_records
           SET amount_rupees = $2, reference = COALESCE(NULLIF($3, ''), reference),
               payswift_payout_id = $4, status = $5, response = $6::jsonb,
               claim_fingerprint = COALESCE(claim_fingerprint, $8),
               created_at = COALESCE($7::timestamptz, created_at)
           WHERE id = $1`,
          [existing.rows[0].id, payout.amount, payout.reference, payout.payout_id, payout.status,
            JSON.stringify({ source: "payswift_ledger", payout: payout.raw, timestamp_missing: !payout.created_at }),
            payout.created_at, fingerprintFromReference(payout.reference)],
        );
      } else {
        await db.query(
          `INSERT INTO payment_records
             (id, rider_id, amount_rupees, reference, idempotency_key, payswift_payout_id, status, response, created_at, claim_fingerprint)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, COALESCE($9::timestamptz, now()), $10)
           ON CONFLICT (payswift_payout_id) DO UPDATE SET
             amount_rupees = EXCLUDED.amount_rupees, reference = EXCLUDED.reference,
             status = EXCLUDED.status, response = EXCLUDED.response,
             created_at = EXCLUDED.created_at`,
          [randomUUID(), riderId, payout.amount, payout.reference || `reconciled:${payout.payout_id}`,
            `ledger:${payout.payout_id}`, payout.payout_id, payout.status,
            JSON.stringify({ source: "payswift_ledger", payout: payout.raw, timestamp_missing: !payout.created_at }),
            payout.created_at, fingerprintFromReference(payout.reference)],
        );
      }
      const claimFingerprint = fingerprintFromReference(payout.reference);
      if (claimFingerprint && providerSuccess(payout)) {
        const recoveredReply = `PaySwift confirms the verified shortfall payment of ₹${payout.amount} (payout ${payout.payout_id}).`;
        await db.query(
          `UPDATE automatic_payment_slots SET status = 'consumed'
           WHERE rider_id = $1 AND claim_fingerprint = $2 AND status IN ('reserved', 'consumed')`,
          [riderId, claimFingerprint],
        );
        await db.query(
          `UPDATE ops_items SET status = 'resolved', resolution_note = $3, resolved_at = now()
           WHERE rider_id = $1 AND claim_fingerprint = $2 AND status IN ('pending', 'approved')
             AND item_type = 'approval' AND reason LIKE 'PaySwift did not return a final result%'`,
          [riderId, claimFingerprint, `Reconciled with PaySwift ledger: payout ${payout.payout_id} is ${payout.status}.`],
        );
        const claim = await db.query<{ last_message_id: string | null }>(
          `UPDATE claim_decisions
           SET latest_decision = latest_decision || jsonb_build_object(
                 'decision_path', 'payment_succeeded',
                 'decision_reason', 'PaySwift ledger reconciliation confirmed the payout.',
                 'reply', $3::text,
                 'payswift_payout_id', $4::text
               ), last_seen_at = now()
           WHERE rider_id = $1 AND claim_fingerprint = $2
           RETURNING last_message_id`,
          [riderId, claimFingerprint, recoveredReply, payout.payout_id],
        );
        const sourceMessageId = claim.rows[0]?.last_message_id;
        if (sourceMessageId) {
          await db.query(
            `UPDATE inbound_messages SET reply = $2
             WHERE message_id = $1 AND rider_id = $3 AND processing_status = 'processed'`,
            [sourceMessageId, recoveredReply, riderId],
          );
        }
        events.push({
          type: "tool_call",
          name: "payswift_payment_reconciled",
          input: { claim_fingerprint: claimFingerprint, payout_id: payout.payout_id },
          output: { amount_rupees: payout.amount, status: payout.status, source: "PaySwift ledger", local_reply_recovered: Boolean(sourceMessageId) },
        });
      }
    }

    // PaySwift is authoritative: retain local audit rows, but mark a previously
    // recorded provider payout missing if a fresh full ledger no longer contains it.
    const disappeared = await db.query<{ claim_fingerprint: string | null; payswift_payout_id: string }>(
      `SELECT claim_fingerprint, payswift_payout_id FROM payment_records
       WHERE rider_id = $1 AND payswift_payout_id IS NOT NULL
         AND lower(status) = ANY($2::text[])`,
      [riderId, [...ACTIVE_STATUSES]],
    );
    for (const row of disappeared.rows) {
      if (seenIds.has(row.payswift_payout_id)) continue;
      await db.query(
        `UPDATE payment_records SET status = 'missing_from_payswift_ledger',
           response = COALESCE(response, '{}'::jsonb) || $3::jsonb
         WHERE rider_id = $1 AND payswift_payout_id = $2`,
        [riderId, row.payswift_payout_id, JSON.stringify({ reconciliation: "not present in latest PaySwift ledger", reconciled_at: new Date().toISOString() })],
      );
      if (row.claim_fingerprint) {
        await db.query(
          `UPDATE automatic_payment_slots SET status = 'released'
           WHERE rider_id = $1 AND claim_fingerprint = $2 AND status IN ('reserved', 'consumed')`,
          [riderId, row.claim_fingerprint],
        );
      }
    }
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
  events.push({
    type: "tool_call",
    name: "payswift_ledger_reconciled",
    input: { rider_id: riderId },
    output: {
      source_of_truth: "PaySwift",
      payout_count: payouts.length,
      payouts: payouts.map(({ payout_id, rider_id, amount, reference, status, created_at }) => ({
        payout_id, rider_id, amount_rupees: amount, reference, status,
        created_at: created_at?.toISOString() ?? null,
      })),
    },
  });
  for (const event of events) {
    await pool.query(
      `INSERT INTO trace_events (rider_id, event_type, name, input_data, output_data)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
      [riderId, event.type, event.name, JSON.stringify(event.input), JSON.stringify(event.output)],
    );
  }
  return { payouts, events };
}

function evidenceLabel(item: ClaimOutcome): string {
  const tripIds = [...new Set(item.assessments.flatMap((assessment) => {
    const fromBreakdown = assessment.breakdown.flatMap((line) => line.match(/\bT\d{6}\b/g) ?? []);
    return assessment.tripId ? [assessment.tripId, ...fromBreakdown] : fromBreakdown;
  }))];
  if (tripIds.length === 1) return ` for trip ${tripIds[0]}`;
  if (tripIds.length > 1) return ` for trips ${tripIds.join(", ")}`;
  const dates = [...new Set(item.assessments.map((assessment) => assessment.payoutDate))];
  return dates.length ? ` for ${dates.join(", ")}` : "";
}

async function markPaymentSucceeded(
  pool: Pool,
  item: ClaimOutcome,
  riderId: string,
  today: string,
  fingerprint: string,
  amount: number,
  payoutId: string,
  reason: string,
): Promise<void> {
  await pool.query("UPDATE automatic_payment_slots SET status = 'consumed' WHERE rider_id = $1 AND payout_date = $2::date AND claim_fingerprint = $3", [riderId, today, fingerprint]);
  item.decision_path = "payment_succeeded";
  item.decision_reason = reason;
  item.reply = `PaySwift confirms the verified shortfall payment of ₹${amount}${evidenceLabel(item)} (payout ${payoutId}).`;
}

async function ledgerPayoutForReference(
  client: PaySwiftClient,
  riderId: string,
  reference: string,
  amount: number,
): Promise<PaySwiftPayout | null> {
  try {
    const payouts = await client.listPayouts(riderId);
    return payouts.find((payout) =>
      payout.reference === reference &&
      payout.amount === amount &&
      !REJECTED_STATUSES.has(payout.status.toLowerCase())) ?? null;
  } catch {
    return null;
  }
}

function retryDelayMs(failure: PaySwiftError, attempt: number): number {
  if (failure.status === 429) return 8000;
  if (failure.status === 409 || /timeout|timed out|aborted/i.test(failure.message)) return 2000;
  return Math.min(300 * attempt, 1500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fingerprintFromReference(reference: string): string | null {
  return /^qd-claim-([a-f0-9]{64})$/.exec(reference)?.[1] ?? null;
}

export async function executeEligiblePayments(
  pool: Pool,
  riderId: string,
  outcomes: ClaimOutcome[],
  client: PaySwiftClient,
): Promise<{ outcomes: ClaimOutcome[]; events: DecisionEvent[] }> {
  const events: DecisionEvent[] = [];
  const today = todayIst();
  for (const item of outcomes) {
    if (item.decision_path !== "auto_payment_eligible") continue;
    const amount = item.decision_amount_rupees ?? 0;
    const fingerprint = item.claim_fingerprint;
    if (!fingerprint || amount < 1 || amount > 200 || amount > (item.verified_owed_rupees ?? 0)) {
      item.decision_path = "payment_guard_rejected";
      item.decision_reason = "Payment authorization failed the deterministic amount or claim-integrity guard.";
      item.reply = "I could not safely prepare this payment, so I have sent the verified claim to operations for review. No payment was requested.";
      const ops = await createPendingOpsItem(pool, {
        riderId, type: "escalation", amount: item.verified_owed_rupees ?? null,
        reason: item.decision_reason, fingerprint: fingerprint ?? null,
        claim: { issue_id: item.issue_id, fingerprint, verified_owed_rupees: item.verified_owed_rupees ?? 0, decision_amount_rupees: amount },
      });
      item.ops_item_id = ops.id;
      events.push({ type: "error", name: "payswift_amount_guard_rejected", input: { issue_id: item.issue_id, amount_rupees: amount }, output: { ops_item_id: ops.id } });
      continue;
    }
    const idempotencyKey = `qd-${fingerprint}`;
    const reference = `qd-claim-${fingerprint}`;
    const localId = randomUUID();
    await pool.query(
      `INSERT INTO payment_records
         (id, rider_id, amount_rupees, reference, idempotency_key, status, claim_fingerprint, response)
       VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [localId, riderId, amount, reference, idempotencyKey, fingerprint,
        JSON.stringify({ source: "agent", stage: "reserved", issue_id: item.issue_id })],
    );
    const record = await pool.query<{ id: string; status: string; payswift_payout_id: string | null }>(
      `SELECT id, status, payswift_payout_id FROM payment_records WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const paymentRecord = record.rows[0];
    if (!paymentRecord) throw new Error("Could not create the payment audit record.");

    if (paymentRecord.payswift_payout_id && providerSuccess({
      payout_id: paymentRecord.payswift_payout_id, rider_id: riderId, amount, reference,
      status: paymentRecord.status, created_at: null, raw: {},
    })) {
      item.decision_path = "payment_succeeded";
      item.decision_reason = "PaySwift ledger confirms the payout for this idempotent claim reference.";
      item.reply = `PaySwift confirms the verified shortfall payment of ₹${amount}${evidenceLabel(item)} (payout ${paymentRecord.payswift_payout_id}).`;
      await pool.query("UPDATE automatic_payment_slots SET status = 'consumed' WHERE rider_id = $1 AND payout_date = $2::date AND claim_fingerprint = $3", [riderId, today, fingerprint]);
      events.push({ type: "decision", name: "payswift_payment_recovered_from_audit", input: { issue_id: item.issue_id, idempotency_key: idempotencyKey }, output: { payout_id: paymentRecord.payswift_payout_id, status: paymentRecord.status } });
      continue;
    }

    await pool.query("UPDATE payment_records SET status = 'processing', response = $2::jsonb WHERE id = $1", [paymentRecord.id, JSON.stringify({ source: "agent", stage: "requesting", idempotency_key: idempotencyKey })]);
    let confirmed: PaySwiftPayout | null = null;
    let failure: PaySwiftError | null = null;
    let attempts = 0;
    let paid = false;
    // The sandbox sleeps, returns 503, or saves a payout and then answers 504.
    // Every retry reuses the same provider key. A saved payout is recovered from
    // the ledger so it is never also turned into an approval.
    for (let attempt = 1; attempt <= 6; attempt++) {
      attempts = attempt;
      try {
        const result = await client.createPayout({ rider_id: riderId, amount, reference }, idempotencyKey);
        confirmed = result.payout;
        await pool.query(
          `UPDATE payment_records SET payswift_payout_id = $2, status = $3, response = $4::jsonb
           WHERE id = $1`,
          [paymentRecord.id, result.payout.payout_id, result.payout.status,
            JSON.stringify({ source: "payswift_create", attempt, response: result.raw })],
        );
        if (providerSuccess(result.payout) || !REJECTED_STATUSES.has(result.payout.status.toLowerCase())) {
          await markPaymentSucceeded(pool, item, riderId, today, fingerprint, amount, result.payout.payout_id, "PaySwift confirmed the verified, policy-limited payout.");
          events.push({ type: "tool_call", name: "payswift_payout_created", input: { rider_id: riderId, amount_rupees: amount, reference, idempotency_key: idempotencyKey }, output: { payout_id: result.payout.payout_id, status: result.payout.status, attempt } });
          failure = null;
          paid = true;
          break;
        }
        failure = new PaySwiftError(`PaySwift reported a non-payment status ${result.payout.status}.`, null, false, false);
        break;
      } catch (error) {
        failure = error instanceof PaySwiftError ? error : new PaySwiftError("Unexpected PaySwift client error.", null, false, true);
      }
      const recovered = await ledgerPayoutForReference(client, riderId, reference, amount);
      if (recovered) {
        confirmed = recovered;
        await pool.query(
          `UPDATE payment_records SET payswift_payout_id = $2, status = $3, response = $4::jsonb WHERE id = $1`,
          [paymentRecord.id, recovered.payout_id, recovered.status, JSON.stringify({ source: "payswift_ledger_after_retry", attempt, payout: recovered.raw })],
        );
        await markPaymentSucceeded(pool, item, riderId, today, fingerprint, amount, recovered.payout_id, "PaySwift ledger confirms the payout after an uncertain provider response.");
        events.push({ type: "tool_call", name: "payswift_payout_recovered", input: { rider_id: riderId, reference, idempotency_key: idempotencyKey, attempt }, output: { payout_id: recovered.payout_id, status: recovered.status } });
        failure = null;
        paid = true;
        break;
      }
      if (!failure?.retryable || attempt === 6) break;
      await sleep(retryDelayMs(failure, attempt));
    }
    if (paid) continue;

    const uncertain = failure?.uncertain ?? Boolean(confirmed);
    const status = uncertain ? "unknown" : "failed";
    const response = {
      source: "payswift_create",
      stage: uncertain ? "result_uncertain" : "rejected",
      attempts,
      http_status: failure?.status ?? null,
      error: failure?.message ?? "PaySwift did not confirm a completed payout.",
      provider_response: confirmed?.raw ?? null,
    };
    await pool.query("UPDATE payment_records SET status = $2, response = $3::jsonb WHERE id = $1", [paymentRecord.id, status, JSON.stringify(response)]);
    if (!uncertain) {
      await pool.query("UPDATE automatic_payment_slots SET status = 'released' WHERE rider_id = $1 AND payout_date = $2::date AND claim_fingerprint = $3", [riderId, today, fingerprint]);
    }
    const reason = uncertain
      ? "PaySwift did not return a final result after bounded retries. The idempotency key and daily slot remain reserved; operations must reconcile the ledger before retrying."
      : `PaySwift rejected the payout request${failure?.status ? ` (HTTP ${failure.status})` : ""}. A retry with the same claim must wait for operations review.`;
    const ops = await createPendingOpsItem(pool, {
      riderId, type: "approval", amount,
      reason: `${reason} Verified shortfall: ₹${amount}.`, fingerprint,
      claim: { issue_id: item.issue_id, fingerprint, verified_owed_rupees: item.verified_owed_rupees, decision_amount_rupees: amount, payment_status: status, idempotency_key: idempotencyKey },
    });
    item.decision_path = uncertain ? "payment_result_uncertain" : "payment_failed_review";
    item.decision_reason = reason;
    item.ops_item_id = ops.id;
    const label = evidenceLabel(item);
    item.reply = uncertain
      ? `I verified a shortfall of ₹${amount}${label}, but PaySwift has not confirmed the payment result. I have sent the case to operations to reconcile before any retry.`
      : `I verified a shortfall of ₹${amount}${label}, but PaySwift rejected the payment request. I have sent the case to operations for review. No payment was made.`;
    events.push({ type: "error", name: "payswift_payment_not_confirmed", input: { issue_id: item.issue_id, idempotency_key: idempotencyKey, attempts }, output: { status, http_status: failure?.status ?? null, ops_item_id: ops.id, daily_slot_retained: uncertain } });
  }
  return { outcomes, events };
}
