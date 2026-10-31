import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { istDate } from "../domain/payouts.js";
import { ClaimOutcome } from "./claims.js";

const AUTO_PAYMENT_CAP_RUPEES = 200;
const ACTIVE_PAYMENT_STATUSES = ["reserved", "processing", "unknown", "succeeded", "paid", "processed", "completed", "success", "created", "pending"];
const SUCCEEDED_PAYMENT_STATUSES = ["succeeded", "paid", "processed", "completed", "success"];

export interface DecisionEvent {
  type: "tool_call" | "decision" | "error";
  name: string;
  input: unknown;
  output: unknown;
}

export interface DecisionResult {
  outcomes: ClaimOutcome[];
  events: DecisionEvent[];
  identityMismatchReply?: string;
}

function fingerprintFor(riderId: string, item: ClaimOutcome): string {
  const details = {
    rider_id: riderId,
    scope: item.scope,
    dates: [...new Set(item.assessments.map((assessment) => assessment.payoutDate))].sort(),
    trip_ids: [...new Set(item.assessments.flatMap((assessment) => assessment.tripId ? [assessment.tripId] : []))].sort(),
    unresolved_reason: item.assessments.length === 0 ? item.reason : null,
  };
  return createHash("sha256").update(JSON.stringify(details)).digest("hex");
}

function claimEvidence(item: ClaimOutcome, fingerprint: string): Record<string, unknown> {
  return {
    issue_id: item.issue_id,
    fingerprint,
    scope: item.scope,
    status: item.status,
    decision_path: item.decision_path,
    decision_reason: item.decision_reason,
    verified_owed_rupees: item.verified_owed_rupees ?? 0,
    decision_amount_rupees: item.decision_amount_rupees ?? null,
    assessments: item.assessments.map((assessment) => ({
      rider_id: assessment.riderId,
      scope: assessment.scope,
      trip_id: assessment.tripId,
      payout_date: assessment.payoutDate,
      expected_rupees: assessment.expectedRupees,
      historical_paid_rupees: assessment.historicalPaidRupees,
      shortfall_rupees: assessment.shortfallRupees,
      breakdown: assessment.breakdown,
    })),
  };
}

export async function createPendingOpsItem(
  pool: Pool,
  args: { riderId: string; type: "approval" | "escalation"; amount: number | null; reason: string; fingerprint: string | null; claim: Record<string, unknown> },
): Promise<{ id: string; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (args.fingerprint) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${args.riderId}:${args.fingerprint}`]);
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM ops_items
         WHERE rider_id = $1 AND claim_fingerprint = $2 AND item_type = $3 AND status = 'pending'
         ORDER BY created_at ASC LIMIT 1`,
        [args.riderId, args.fingerprint, args.type],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { id: existing.rows[0].id, created: false };
      }
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO ops_items (id, rider_id, item_type, amount_rupees, reason, status, claim, claim_fingerprint)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb, $7)`,
      [id, args.riderId, args.type, args.amount, args.reason, JSON.stringify(args.claim), args.fingerprint],
    );
    await client.query("COMMIT");
    return { id, created: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function hasPriorClaim(pool: Pool, riderId: string, fingerprint: string): Promise<boolean> {
  const result = await pool.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM payment_records
       WHERE rider_id = $1 AND claim_fingerprint = $2
         AND lower(status) IN ('reserved', 'processing', 'succeeded', 'paid', 'completed')
       UNION ALL
       SELECT 1 FROM ops_items
       WHERE rider_id = $1 AND claim_fingerprint = $2
         AND item_type = 'approval' AND status IN ('pending', 'approved', 'resolved')
     ) AS found`,
    [riderId, fingerprint],
  );
  return result.rows[0]?.found ?? false;
}

async function successfulPaymentForClaim(pool: Pool, riderId: string, fingerprint: string): Promise<{ payout_id: string | null; amount: number } | null> {
  const result = await pool.query<{ payout_id: string | null; amount: number }>(
    `SELECT payswift_payout_id AS payout_id, amount_rupees AS amount
     FROM payment_records WHERE rider_id = $1 AND claim_fingerprint = $2
       AND lower(status) = ANY($3::text[]) ORDER BY created_at DESC LIMIT 1`,
    [riderId, fingerprint, SUCCEEDED_PAYMENT_STATUSES],
  );
  return result.rows[0] ?? null;
}

async function recordClaimOccurrence(
  pool: Pool,
  riderId: string,
  fingerprint: string,
  messageId: string,
  claim: Record<string, unknown>,
): Promise<number> {
  const result = await pool.query<{ occurrence_count: number }>(
    `INSERT INTO claim_decisions (rider_id, claim_fingerprint, occurrence_count, last_message_id, latest_decision)
     VALUES ($1, $2, 1, $3, $4::jsonb)
     ON CONFLICT (rider_id, claim_fingerprint) DO UPDATE
       SET occurrence_count = claim_decisions.occurrence_count +
             CASE WHEN claim_decisions.last_message_id IS DISTINCT FROM EXCLUDED.last_message_id THEN 1 ELSE 0 END,
           last_message_id = EXCLUDED.last_message_id,
           latest_decision = EXCLUDED.latest_decision,
           last_seen_at = now()
     RETURNING occurrence_count`,
    [riderId, fingerprint, messageId, JSON.stringify(claim)],
  );
  return Number(result.rows[0]?.occurrence_count ?? 1);
}

async function updateClaimDecision(
  pool: Pool,
  riderId: string,
  fingerprint: string,
  claim: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `UPDATE claim_decisions
     SET latest_decision = $3::jsonb, last_seen_at = now()
     WHERE rider_id = $1 AND claim_fingerprint = $2`,
    [riderId, fingerprint, JSON.stringify(claim)],
  );
}

async function hasPaymentOnIstDate(pool: Pool, riderId: string, date: string): Promise<boolean> {
  const result = await pool.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM payment_records
       WHERE rider_id = $1
         AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
         AND lower(status) = ANY($3::text[])
     ) AS found`,
    [riderId, date, ACTIVE_PAYMENT_STATUSES],
  );
  return result.rows[0]?.found ?? false;
}

async function hasOtherActiveSlot(pool: Pool, riderId: string, date: string, fingerprint: string): Promise<boolean> {
  const result = await pool.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM automatic_payment_slots
       WHERE rider_id = $1 AND payout_date = $2::date
         AND claim_fingerprint <> $3 AND status IN ('reserved', 'consumed')
     ) AS found`,
    [riderId, date, fingerprint],
  );
  return result.rows[0]?.found ?? false;
}

async function reserveAutomaticSlot(
  pool: Pool,
  riderId: string,
  date: string,
  fingerprint: string,
  amount: number,
): Promise<boolean> {
  const result = await pool.query<{ claim_fingerprint: string }>(
    `INSERT INTO automatic_payment_slots (rider_id, payout_date, claim_fingerprint, amount_rupees, status)
     VALUES ($1, $2::date, $3, $4, 'reserved')
     ON CONFLICT (rider_id, payout_date) DO UPDATE
       SET claim_fingerprint = EXCLUDED.claim_fingerprint,
           amount_rupees = EXCLUDED.amount_rupees,
           status = 'reserved',
           created_at = now()
       WHERE automatic_payment_slots.status = 'released'
          OR automatic_payment_slots.claim_fingerprint = EXCLUDED.claim_fingerprint
     RETURNING claim_fingerprint`,
    [riderId, date, fingerprint, amount],
  );
  return result.rows[0]?.claim_fingerprint === fingerprint;
}

export async function decideClaimPaths(
  pool: Pool,
  riderId: string,
  outcomes: ClaimOutcome[],
  args: { messageId: string; identityMismatch: boolean; paymentProviderAvailable?: boolean },
): Promise<DecisionResult> {
  const events: DecisionEvent[] = [];
  if (args.identityMismatch) {
    const incidentFingerprint = createHash("sha256").update(`${riderId}:identity-mismatch:${args.messageId}`).digest("hex");
    const reason = "The message references a different rider identity; payout details were not checked.";
    const claim = {
      issue_id: null,
      fingerprint: incidentFingerprint,
      scope: null,
      status: "suspicious",
      decision_path: "suspicious_escalation",
      decision_reason: reason,
      verified_owed_rupees: 0,
      assessments: [],
      evidence: { identity_mismatch: true, message_id: args.messageId },
    };
    const opsItem = await createPendingOpsItem(pool, {
      riderId,
      type: "escalation",
      amount: null,
      reason,
      fingerprint: incidentFingerprint,
      claim,
    });
    events.push({
      type: "decision",
      name: "suspicious_claim_escalated",
      input: { message_id: args.messageId, rider_id: riderId },
      output: { ops_item_id: opsItem.id, created: opsItem.created, reason, verified_owed_rupees: 0 },
    });
    return {
      outcomes,
      events,
      identityMismatchReply: "I can help only with the rider account linked to this number. I have sent this identity mismatch to the operations team for review.",
    };
  }

  // This cap follows the actual processing/payment day, not a rider-supplied or backdated received_at.
  const paymentIstDate = istDate(new Date());
  const paymentAlreadyMadeToday = await hasPaymentOnIstDate(pool, riderId, paymentIstDate);
  const decided: ClaimOutcome[] = [];

  for (const source of outcomes) {
    const item: ClaimOutcome = { ...source };
    const fullyAssessed = item.status === "verified_shortfall" || item.status === "no_shortfall";
    const verifiedOwed = fullyAssessed
      ? Math.max(0, item.assessments.reduce((sum, assessment) => sum + assessment.shortfallRupees, 0))
      : 0;
    item.verified_owed_rupees = verifiedOwed;
    const fingerprint = fingerprintFor(riderId, item);
    item.claim_fingerprint = fingerprint;
    const occurrenceCount = item.status === "needs_information" || item.status === "unclear" || item.status === "suspicious"
      ? 0
      : await recordClaimOccurrence(pool, riderId, fingerprint, args.messageId, claimEvidence(item, fingerprint));

    if (item.status === "needs_information") {
      item.decision_path = "needs_information";
      item.decision_reason = "Required claim details are missing.";
    } else if (item.status === "suspicious") {
      item.decision_path = "suspicious_escalation";
      item.decision_reason = item.reason;
      const opsItem = await createPendingOpsItem(pool, {
        riderId, type: "escalation", amount: null, reason: `Possible account or trip ownership mismatch: ${item.reason}`,
        fingerprint, claim: claimEvidence(item, fingerprint),
      });
      item.ops_item_id = opsItem.id;
      item.reply = "The trip details do not match the rider account linked to this number. I have sent the case to the operations team to review.";
    } else if (item.status === "unclear") {
      item.decision_path = "unclear_escalation";
      item.decision_reason = item.reason;
      const opsItem = await createPendingOpsItem(pool, {
        riderId, type: "escalation", amount: null, reason: `Claim could not be verified: ${item.reason}`,
        fingerprint, claim: claimEvidence(item, fingerprint),
      });
      item.ops_item_id = opsItem.id;
      item.reply = `I could not verify this claim from the available records: ${item.reason}. I have sent it to the operations team for review.`;
    } else if (verifiedOwed === 0) {
      item.decision_path = "no_payment_due";
      item.decision_reason = "The checked policy and payout records show no positive shortfall.";
    } else if ((occurrenceCount > 1 || await hasPriorClaim(pool, riderId, fingerprint)) && await successfulPaymentForClaim(pool, riderId, fingerprint)) {
      const priorPayment = await successfulPaymentForClaim(pool, riderId, fingerprint);
      item.decision_path = "repeat_already_paid_escalation";
      item.decision_reason = "PaySwift already records a completed payment for this exact claim; a repeat report is sent to operations without creating another payable approval.";
      const opsItem = await createPendingOpsItem(pool, {
        riderId, type: "escalation", amount: null,
        reason: `${item.decision_reason} Existing payout ID: ${priorPayment?.payout_id ?? "not supplied by PaySwift"}; amount: ₹${priorPayment?.amount ?? 0}.`,
        fingerprint, claim: claimEvidence(item, fingerprint),
      });
      item.ops_item_id = opsItem.id;
      item.reply = `PaySwift records a ₹${priorPayment?.amount ?? 0} payment for this claim${priorPayment?.payout_id ? ` (payout ${priorPayment.payout_id})` : ""}. Since this is a repeat report, I have sent it to operations to review; I have not sent another payment.`;
    } else if (occurrenceCount > 1 || await hasPriorClaim(pool, riderId, fingerprint)) {
      item.decision_path = "repeat_claim_approval";
      item.decision_reason = "A prior approved or active payment record matches this rider, trip/date, and claim.";
      item.decision_amount_rupees = verifiedOwed;
      const opsItem = await createPendingOpsItem(pool, {
        riderId, type: "approval", amount: verifiedOwed,
        reason: `Repeat claim requires manual review; verified amount is ₹${verifiedOwed}.`,
        fingerprint, claim: claimEvidence(item, fingerprint),
      });
      item.ops_item_id = opsItem.id;
      item.reply = `The verified shortfall is ₹${verifiedOwed}. This matches a prior claim, so I have sent it for operations approval before any payment.`;
    } else if (verifiedOwed > AUTO_PAYMENT_CAP_RUPEES) {
      item.decision_path = "large_claim_approval";
      item.decision_reason = `Verified amount ₹${verifiedOwed} is above the ₹${AUTO_PAYMENT_CAP_RUPEES} automatic-payment limit per dispute.`;
      item.decision_amount_rupees = verifiedOwed;
      const opsItem = await createPendingOpsItem(pool, {
        riderId, type: "approval", amount: verifiedOwed,
        reason: item.decision_reason,
        fingerprint, claim: claimEvidence(item, fingerprint),
      });
      item.ops_item_id = opsItem.id;
      item.reply = `I verified a shortfall of ₹${verifiedOwed}. This is above the ₹${AUTO_PAYMENT_CAP_RUPEES} automatic limit, so I have sent it to operations for approval. No payment has been made.`;
    } else if (args.paymentProviderAvailable === false) {
      item.decision_path = "payment_provider_unavailable";
      item.decision_reason = "PaySwift ledger could not be reconciled, so automatic payment was not attempted.";
      item.decision_amount_rupees = verifiedOwed;
      const opsItem = await createPendingOpsItem(pool, {
        riderId, type: "approval", amount: verifiedOwed,
        reason: `${item.decision_reason} Verified shortfall: ₹${verifiedOwed}.`,
        fingerprint, claim: claimEvidence(item, fingerprint),
      });
      item.ops_item_id = opsItem.id;
      item.reply = `I verified a shortfall of ₹${verifiedOwed}, but I could not confirm the PaySwift ledger. I have sent it to operations for review; no payment was made.`;
    } else if (paymentAlreadyMadeToday || await hasOtherActiveSlot(pool, riderId, paymentIstDate, fingerprint)) {
      item.decision_path = "daily_limit_approval";
      item.decision_reason = `The one automatic payment per rider per IST day limit has already been used or reserved on ${paymentIstDate}.`;
      item.decision_amount_rupees = verifiedOwed;
      const opsItem = await createPendingOpsItem(pool, {
        riderId, type: "approval", amount: verifiedOwed,
        reason: `Daily automatic-payment limit used or reserved on ${paymentIstDate}; verified amount is ₹${verifiedOwed}.`,
        fingerprint, claim: claimEvidence(item, fingerprint),
      });
      item.ops_item_id = opsItem.id;
      item.reply = `I verified a shortfall of ₹${verifiedOwed}, but the one automatic payment allowed for your account on ${paymentIstDate} has already been used or reserved. I have sent this claim to operations for approval. No payment has been made.`;
    } else {
      // Reserve the single daily slot before the PaySwift request is made.
      const autoAmount = Math.min(verifiedOwed, AUTO_PAYMENT_CAP_RUPEES);
      const reserved = await reserveAutomaticSlot(pool, riderId, paymentIstDate, fingerprint, autoAmount);
      if (!reserved) {
        item.decision_path = "daily_limit_approval";
        item.decision_reason = `Another claim already reserved the one automatic payment slot for ${paymentIstDate}.`;
        item.decision_amount_rupees = verifiedOwed;
        const opsItem = await createPendingOpsItem(pool, {
          riderId, type: "approval", amount: verifiedOwed,
          reason: `Daily automatic-payment limit reserved on ${paymentIstDate}; verified amount is ₹${verifiedOwed}.`,
          fingerprint, claim: claimEvidence(item, fingerprint),
        });
        item.ops_item_id = opsItem.id;
        item.reply = `I verified a shortfall of ₹${verifiedOwed}, but your automatic-payment slot for ${paymentIstDate} is already reserved. I have sent this claim to operations for approval. No payment has been made.`;
      } else {
        item.decision_path = "auto_payment_eligible";
        item.decision_reason = `Verified amount is within the ₹${AUTO_PAYMENT_CAP_RUPEES} per-dispute limit and this claim reserved the rider's one automatic-payment slot for ${paymentIstDate}.`;
        item.decision_amount_rupees = autoAmount;
        item.reply = `I verified a shortfall of ₹${autoAmount}. It is within the automatic-payment limits and reserved for processing, but no payment was made in this step.`;
      }
    }

    events.push({
      type: "decision",
      name: "claim_payment_path_selected",
      input: { issue_id: item.issue_id, rider_id: riderId, scope: item.scope, fingerprint },
      output: {
        path: item.decision_path,
        reason: item.decision_reason,
        payment_ist_date: paymentIstDate,
        verified_owed_rupees: verifiedOwed,
        amount_never_exceeds_verified_owed: (item.decision_amount_rupees ?? 0) <= verifiedOwed,
        per_dispute_cap_rupees: AUTO_PAYMENT_CAP_RUPEES,
        daily_ist_limit: 1,
        ops_item_id: item.ops_item_id ?? null,
      },
    });
    if (occurrenceCount > 0) {
      await updateClaimDecision(pool, riderId, fingerprint, claimEvidence(item, fingerprint));
    }
    decided.push(item);
  }
  return { outcomes: decided, events };
}
