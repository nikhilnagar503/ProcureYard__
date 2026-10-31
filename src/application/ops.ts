import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PaySwiftClient, PaySwiftError } from "../infrastructure/payswift/client.js";
import { reconcilePaySwiftLedger } from "./payments.js";

export interface PendingOpsItem {
  id: string;
  rider_id: string;
  type: "approval" | "escalation";
  amount: number | null;
  reason: string;
  claim: Record<string, unknown>;
  status: "pending" | "approved";
  created_at: Date;
}

export interface OpsConversation {
  rider_id: string;
  message_id: string;
  text: string;
  reply: string | null;
  received_at: Date;
  state: Record<string, unknown>;
}

export interface OpsConversationDetail extends OpsConversation {
  messages: Array<{ message_id: string; text: string; reply: string | null; received_at: Date; processing_status: string }>;
}

const SUCCESS_STATUSES = new Set(["succeeded", "paid", "processed", "completed", "success"]);
const FAILURE_STATUSES = new Set(["failed", "rejected", "cancelled", "canceled", "error"]);

export async function getPendingOpsItems(pool: Pool): Promise<PendingOpsItem[]> {
  const result = await pool.query<PendingOpsItem>(
    `SELECT id, rider_id, item_type AS type, amount_rupees AS amount, reason, claim, status, created_at
     FROM ops_items WHERE status IN ('pending', 'approved') ORDER BY created_at ASC, id ASC`,
  );
  return result.rows;
}

export async function getOpsConversations(pool: Pool): Promise<OpsConversation[]> {
  const result = await pool.query<OpsConversation>(
    `SELECT latest.rider_id, latest.message_id, latest.text, latest.reply, latest.received_at,
            COALESCE(c.state, '{}'::jsonb) AS state
     FROM (
       SELECT DISTINCT ON (rider_id) rider_id, message_id, text, reply, received_at
       FROM inbound_messages ORDER BY rider_id, received_at DESC, created_at DESC
     ) latest
     LEFT JOIN conversations c ON c.rider_id = latest.rider_id
     ORDER BY latest.received_at DESC
     LIMIT 200`,
  );
  return result.rows;
}

export async function getOpsConversation(pool: Pool, riderId: string): Promise<OpsConversationDetail | null> {
  const [latest, history] = await Promise.all([
    pool.query<OpsConversation>(
      `SELECT m.rider_id, m.message_id, m.text, m.reply, m.received_at,
              COALESCE(c.state, '{}'::jsonb) AS state
       FROM inbound_messages m LEFT JOIN conversations c ON c.rider_id = m.rider_id
       WHERE m.rider_id = $1 ORDER BY m.received_at DESC, m.created_at DESC LIMIT 1`,
      [riderId],
    ),
    pool.query<{ message_id: string; text: string; reply: string | null; received_at: Date; processing_status: string }>(
      `SELECT message_id, text, reply, received_at, processing_status FROM (
         SELECT message_id, text, reply, received_at, processing_status, created_at
         FROM inbound_messages WHERE rider_id = $1 ORDER BY received_at DESC, created_at DESC LIMIT 100
       ) recent ORDER BY received_at ASC, message_id ASC`,
      [riderId],
    ),
  ]);
  const row = latest.rows[0];
  return row ? { ...row, messages: history.rows } : null;
}

export class OpsActionError extends Error {
  constructor(readonly httpStatus: number, message: string) { super(message); }
}

interface OpsRow {
  id: string;
  rider_id: string;
  item_type: "approval" | "escalation";
  amount_rupees: number | null;
  reason: string;
  claim: unknown;
  status: string;
  claim_fingerprint: string | null;
}

interface VerifiedClaim {
  fingerprint: string;
  status: string;
  verified_owed_rupees: number;
  decision_amount_rupees: number;
  assessments: Array<{ shortfall_rupees: number }>;
}

function verifiedClaim(row: OpsRow): VerifiedClaim {
  const claim = row.claim && typeof row.claim === "object" && !Array.isArray(row.claim)
    ? row.claim as Record<string, unknown> : {};
  const assessments = Array.isArray(claim.assessments) ? claim.assessments : [];
  const verified = Number(claim.verified_owed_rupees);
  const decisionAmount = Number(claim.decision_amount_rupees);
  const assessmentTotal = assessments.reduce((sum: number, entry: unknown) => {
    if (!entry || typeof entry !== "object" || !Number.isInteger(Number((entry as Record<string, unknown>).shortfall_rupees))) {
      return Number.NaN;
    }
    return sum + Number((entry as Record<string, unknown>).shortfall_rupees);
  }, 0);
  if (row.item_type !== "approval" || !row.claim_fingerprint || claim.fingerprint !== row.claim_fingerprint ||
      claim.status !== "verified_shortfall" || !Number.isInteger(verified) || verified <= 0 ||
      !Number.isInteger(decisionAmount) || decisionAmount !== verified || row.amount_rupees !== verified ||
      assessments.length === 0 || assessmentTotal !== verified) {
    throw new OpsActionError(409, "This item does not contain a consistent, previously verified payable amount.");
  }
  return {
    fingerprint: row.claim_fingerprint,
    status: "verified_shortfall",
    verified_owed_rupees: verified,
    decision_amount_rupees: decisionAmount,
    assessments: assessments as Array<{ shortfall_rupees: number }>,
  };
}

async function appendOpsTrace(
  pool: Pool,
  riderId: string,
  name: string,
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  type: "decision" | "tool_call" | "error" = "decision",
): Promise<void> {
  await pool.query(
    `INSERT INTO trace_events (rider_id, event_type, name, input_data, output_data)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [riderId, type, name, JSON.stringify(input), JSON.stringify(output)],
  );
}

export async function rejectOpsItem(
  pool: Pool,
  itemId: string,
  reviewer: string,
  note: string,
): Promise<{ id: string; status: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<OpsRow>("SELECT * FROM ops_items WHERE id = $1 FOR UPDATE", [itemId]);
    const item = result.rows[0];
    if (!item) throw new OpsActionError(404, "Operations item was not found.");
    if (item.status !== "pending") throw new OpsActionError(409, `This item is already ${item.status}.`);
    await client.query(
      `UPDATE ops_items SET status = 'rejected', resolution_note = $2, resolved_at = now() WHERE id = $1`,
      [itemId, `${note.trim() || "Rejected by operations."} Reviewed by ${reviewer}.`],
    );
    await client.query(
      `INSERT INTO trace_events (rider_id, event_type, name, input_data, output_data)
       VALUES ($1, 'decision', 'ops_claim_rejected', $2::jsonb, $3::jsonb)`,
      [item.rider_id, JSON.stringify({ ops_item_id: itemId, claim_fingerprint: item.claim_fingerprint, reviewer }),
        JSON.stringify({ status: "rejected", note: note.trim() || null, payment_requested: false })],
    );
    await client.query("COMMIT");
    return { id: itemId, status: "rejected" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function approveOpsItem(
  pool: Pool,
  itemId: string,
  reviewer: string,
  paySwift: PaySwiftClient,
): Promise<{ id: string; status: string; amount_rupees: number; payout_id?: string | null; detail: string }> {
  // Read the provider ledger before authorizing. If an earlier request reached
  // PaySwift but its reply was lost, ledger reconciliation recovers that payout.
  const preview = await pool.query<{ rider_id: string; item_type: string }>("SELECT rider_id, item_type FROM ops_items WHERE id = $1", [itemId]);
  if (!preview.rows[0]) throw new OpsActionError(404, "Operations item was not found.");
  if (preview.rows[0].item_type !== "approval") throw new OpsActionError(409, "Escalations cannot be approved as a payment.");
  try {
    await reconcilePaySwiftLedger(pool, preview.rows[0].rider_id, paySwift);
  } catch (error) {
    await appendOpsTrace(pool, preview.rows[0].rider_id, "ops_approval_ledger_check_failed",
      { ops_item_id: itemId }, { error: error instanceof Error ? error.message : "unknown provider error", payment_requested: false }, "error");
    throw error;
  }
  const reconciled = await pool.query<{ status: string; amount_rupees: number | null; payswift_payout_id: string | null; resolution_note: string | null }>(
    `SELECT oi.status, oi.amount_rupees, oi.resolution_note, pr.payswift_payout_id
     FROM ops_items oi LEFT JOIN payment_records pr
       ON pr.rider_id = oi.rider_id AND pr.claim_fingerprint = oi.claim_fingerprint
     WHERE oi.id = $1 ORDER BY pr.created_at DESC LIMIT 1`, [itemId],
  );
  if (reconciled.rows[0]?.status === "resolved") {
    return {
      id: itemId,
      status: "resolved",
      amount_rupees: reconciled.rows[0].amount_rupees ?? 0,
      payout_id: reconciled.rows[0].payswift_payout_id,
      detail: reconciled.rows[0].resolution_note ?? "PaySwift ledger reconciliation completed this item.",
    };
  }

  const client = await pool.connect();
  let authorized: { item: OpsRow; claim: VerifiedClaim; amount: number; fingerprint: string; idempotencyKey: string; reference: string; paymentId: string };
  try {
    await client.query("BEGIN");
    const result = await client.query<OpsRow>("SELECT * FROM ops_items WHERE id = $1 FOR UPDATE", [itemId]);
    const item = result.rows[0];
    if (!item) throw new OpsActionError(404, "Operations item was not found.");
    if (item.status !== "pending" && item.status !== "approved") throw new OpsActionError(409, `This item is already ${item.status}.`);
    const claim = verifiedClaim(item);
    const amount = claim.decision_amount_rupees;
    if (amount > 10000) throw new OpsActionError(422, "PaySwift cannot accept a payout larger than ₹10,000; this claim needs a different operations process.");
    const existing = await client.query<{ id: string; amount_rupees: number; rider_id: string; claim_fingerprint: string | null; status: string; payswift_payout_id: string | null }>(
      `SELECT id, rider_id, amount_rupees, claim_fingerprint, status, payswift_payout_id
       FROM payment_records WHERE idempotency_key = $1 FOR UPDATE`, [`qd-${claim.fingerprint}`],
    );
    let payment = existing.rows[0];
    if (payment && (payment.rider_id !== item.rider_id || payment.amount_rupees !== amount || payment.claim_fingerprint !== claim.fingerprint)) {
      throw new OpsActionError(409, "An existing payment audit record conflicts with the verified claim; no payout was requested.");
    }
    if (payment && SUCCESS_STATUSES.has(payment.status.toLowerCase())) {
      await client.query(
        `UPDATE ops_items SET status = 'resolved', resolution_note = $2, resolved_at = now() WHERE id = $1`,
        [itemId, `PaySwift ledger already contains payout ${payment.payswift_payout_id ?? "with confirmed status"}; no second request sent.`],
      );
      await client.query(
        `INSERT INTO trace_events (rider_id, event_type, name, input_data, output_data)
         VALUES ($1, 'decision', 'ops_approval_already_paid', $2::jsonb, $3::jsonb)`,
        [item.rider_id, JSON.stringify({ ops_item_id: itemId, fingerprint: claim.fingerprint, reviewer }),
          JSON.stringify({ amount_rupees: amount, payout_id: payment.payswift_payout_id, payment_requested: false })],
      );
      await client.query("COMMIT");
      return { id: itemId, status: "resolved", amount_rupees: amount, payout_id: payment.payswift_payout_id, detail: "PaySwift already records this claim; no additional payout was sent." };
    }
    if (payment && payment.payswift_payout_id && !FAILURE_STATUSES.has(payment.status.toLowerCase())) {
      throw new OpsActionError(409, "A PaySwift payout has a non-final status. Reconcile the provider ledger before approving it again.");
    }
    if (!payment) {
      const paymentId = randomUUID();
      await client.query(
        `INSERT INTO payment_records (id, rider_id, amount_rupees, reference, idempotency_key, status, claim_fingerprint, response)
         VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7::jsonb)`,
        [paymentId, item.rider_id, amount, `qd-claim-${claim.fingerprint}`, `qd-${claim.fingerprint}`, claim.fingerprint,
          JSON.stringify({ source: "ops_approval", stage: "reserved", ops_item_id: itemId, reviewer })],
      );
      payment = { id: paymentId, rider_id: item.rider_id, amount_rupees: amount, claim_fingerprint: claim.fingerprint, status: "reserved", payswift_payout_id: null };
    }
    const reference = `qd-claim-${claim.fingerprint}`;
    const idempotencyKey = `qd-${claim.fingerprint}`;
    await client.query(
      `UPDATE payment_records SET status = 'processing', response = $2::jsonb WHERE id = $1`,
      [payment.id, JSON.stringify({ source: "ops_approval", stage: "requesting", ops_item_id: itemId, reviewer, idempotency_key: idempotencyKey })],
    );
    await client.query(
      `UPDATE ops_items SET status = 'approved', resolution_note = $2 WHERE id = $1`,
      [itemId, `Approved by ${reviewer}; requesting the verified ₹${amount} with stable idempotency key.`],
    );
    await client.query(
      `INSERT INTO trace_events (rider_id, event_type, name, input_data, output_data)
       VALUES ($1, 'decision', 'ops_claim_approved', $2::jsonb, $3::jsonb)`,
      [item.rider_id,
        JSON.stringify({ ops_item_id: itemId, fingerprint: claim.fingerprint, reviewer, source: "stored_verified_claim" }),
        JSON.stringify({ amount_rupees: amount, verified_owed_rupees: claim.verified_owed_rupees, idempotency_key: idempotencyKey })],
    );
    await client.query("COMMIT");
    authorized = { item, claim, amount, fingerprint: claim.fingerprint, idempotencyKey, reference, paymentId: payment.id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let failure: PaySwiftError | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await paySwift.createPayout({
        rider_id: authorized.item.rider_id,
        amount: authorized.amount,
        reference: authorized.reference,
      }, authorized.idempotencyKey);
      const status = result.payout.status.toLowerCase();
      await pool.query(
        `UPDATE payment_records SET payswift_payout_id = $2, status = $3, response = $4::jsonb WHERE id = $1`,
        [authorized.paymentId, result.payout.payout_id, result.payout.status,
          JSON.stringify({ source: "payswift_ops_approval", attempt, response: result.raw })],
      );
      if (SUCCESS_STATUSES.has(status)) {
        await pool.query(
          `UPDATE ops_items SET status = 'resolved', resolution_note = $2, resolved_at = now() WHERE id = $1`,
          [itemId, `PaySwift confirmed payout ${result.payout.payout_id} of ₹${authorized.amount}; approved by ${reviewer}.`],
        );
        await appendOpsTrace(pool, authorized.item.rider_id, "payswift_ops_payout_confirmed",
          { ops_item_id: itemId, amount_rupees: authorized.amount, idempotency_key: authorized.idempotencyKey },
          { payout_id: result.payout.payout_id, status: result.payout.status, attempt }, "tool_call");
        return { id: itemId, status: "resolved", amount_rupees: authorized.amount, payout_id: result.payout.payout_id, detail: "PaySwift confirmed the approved payout." };
      }
      if (FAILURE_STATUSES.has(status)) {
        failure = new PaySwiftError(`PaySwift returned ${result.payout.status}.`, null, false, false);
      } else {
        failure = new PaySwiftError(`PaySwift returned non-final status ${result.payout.status}.`, null, false, true);
      }
      break;
    } catch (error) {
      failure = error instanceof PaySwiftError ? error : new PaySwiftError("Unexpected PaySwift client error.", null, false, true);
      if (!failure.retryable || attempt === 2) break;
    }
  }

  const uncertain = failure?.uncertain ?? true;
  const paymentStatus = uncertain ? "unknown" : "failed";
  await pool.query(
    `UPDATE payment_records SET status = $2, response = $3::jsonb WHERE id = $1`,
    [authorized.paymentId, paymentStatus, JSON.stringify({ source: "payswift_ops_approval", result: paymentStatus,
      error: failure?.message ?? "PaySwift did not confirm the payout.", idempotency_key: authorized.idempotencyKey })],
  );
  if (!uncertain) {
    await pool.query(
      `UPDATE ops_items SET status = 'pending', resolution_note = $2 WHERE id = $1`,
      [itemId, `PaySwift rejected the payout. It remains in the review queue. ${failure?.message ?? ""}`],
    );
  }
  await appendOpsTrace(pool, authorized.item.rider_id, "payswift_ops_payout_not_confirmed",
    { ops_item_id: itemId, amount_rupees: authorized.amount, idempotency_key: authorized.idempotencyKey },
    { status: paymentStatus, error: failure?.message ?? "unknown provider result", retry_with_same_key_only: true }, "error");
  return {
    id: itemId,
    status: uncertain ? "approved" : "pending",
    amount_rupees: authorized.amount,
    payout_id: null,
    detail: uncertain
      ? "PaySwift did not return a final result. The item stays approved and payment is blocked from a new key; reconcile the PaySwift ledger before trying again."
      : "PaySwift rejected the payout. The item is back in the review queue; any retry must reuse the same idempotency key.",
  };
}
