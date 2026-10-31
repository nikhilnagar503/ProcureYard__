import { Pool } from "pg";
import {
  assessDay,
  assessTrip,
  disputeIsInWindow,
  istDate,
  PayoutAssessment,
  PayoutLine,
  TripRecord,
} from "../domain/payouts.js";
import { IssueUpdate } from "../infrastructure/llm/groq-client.js";

export type ClaimStatus = "needs_information" | "verified_shortfall" | "no_shortfall" | "unclear" | "suspicious";

export interface InvestigationTarget {
  issueId: string;
  update: IssueUpdate;
}

export interface InvestigationEvent {
  type: "tool_call" | "decision" | "error";
  name: string;
  input: unknown;
  output: unknown;
}

export interface ClaimOutcome {
  issue_id: string;
  status: ClaimStatus;
  scope: "trip" | "day" | null;
  reason: string;
  assessments: PayoutAssessment[];
  decision_path?: "needs_information" | "unclear_escalation" | "suspicious_escalation" | "large_claim_approval" | "repeat_claim_approval" | "repeat_already_paid_escalation" | "daily_limit_approval" | "payment_provider_unavailable" | "payment_guard_rejected" | "auto_payment_eligible" | "payment_succeeded" | "payment_result_uncertain" | "payment_failed_review" | "no_payment_due";
  decision_reason?: string;
  verified_owed_rupees?: number;
  decision_amount_rupees?: number | null;
  ops_item_id?: string | null;
  claim_fingerprint?: string;
  reply: string;
}

export interface InvestigationResult {
  outcomes: ClaimOutcome[];
  events: InvestigationEvent[];
}

interface DbTrip {
  trip_id: string;
  rider_id: string;
  started_at: Date;
  status: TripRecord["status"];
  distance_km: string;
  surge_multiplier: string;
}

interface DbPayoutLine {
  line_id: string;
  payout_date: string;
  rider_id: string;
  line_type: string;
  trip_id: string | null;
  amount_rupees: number;
}

function canonicalRiderId(value: string): string {
  const match = /^R(\d+)$/i.exec(value.trim());
  return match ? `R${Number(match[1]).toString().padStart(3, "0")}` : value.trim().toUpperCase();
}

function toTrip(row: DbTrip): TripRecord {
  return {
    tripId: row.trip_id,
    riderId: row.rider_id,
    startedAt: row.started_at,
    status: row.status,
    distanceKm: row.distance_km,
    surgeMultiplier: row.surge_multiplier,
  };
}

function toPayoutLine(row: DbPayoutLine): PayoutLine {
  return {
    lineId: row.line_id,
    payoutDate: row.payout_date,
    riderId: row.rider_id,
    lineType: row.line_type,
    tripId: row.trip_id,
    amountRupees: Number(row.amount_rupees),
  };
}

function resultStatus(shortfall: number): ClaimStatus {
  return shortfall > 0 ? "verified_shortfall" : "no_shortfall";
}

function resultReply(status: ClaimStatus, assessments: PayoutAssessment[], reason: string): string {
  if (status === "needs_information") {
    return reason === "date"
      ? "Could you share the trip ID or the date of the payout you want checked?"
      : "Could you share the trip ID related to the payout issue?";
  }
  if (status === "unclear") {
    return `I could not verify this claim from the available records: ${reason}. I have sent it to the operations team for review.`;
  }
  if (status === "suspicious") {
    return `The trip details do not match the rider account linked to this number. I have sent the case to the operations team to review.`;
  }

  const totalExpected = assessments.reduce((sum, item) => sum + item.expectedRupees, 0);
  const totalPaid = assessments.reduce((sum, item) => sum + item.historicalPaidRupees, 0);
  const shortfall = totalExpected - totalPaid;
  const dates = [...new Set(assessments.map((item) => item.payoutDate))];
  const dateLabel = dates.length === 1 ? dates[0] : dates.join(", ");
  const dayTripIds = assessments.flatMap((assessment) =>
    assessment.tripId ? [assessment.tripId] : assessment.breakdown.flatMap((line) => line.match(/\bT\d{6}\b/g) ?? []));
  const uniqueDayTripIds = [...new Set(dayTripIds)];
  const tripContext = uniqueDayTripIds.length
    ? ` (including trip${uniqueDayTripIds.length === 1 ? "" : "s"} ${uniqueDayTripIds.slice(0, 5).join(", ")}${uniqueDayTripIds.length > 5 ? ` and ${uniqueDayTripIds.length - 5} more` : ""})`
    : "";
  const checkedRecords = `the ${assessments.length === 1 && assessments[0]!.scope === "trip" ? `trip ${assessments[0]!.tripId}` : `payout records${tripContext}`} for ${dateLabel}`;
  const incentiveNotes = assessments.flatMap((assessment) => assessment.breakdown.filter((line) => line.startsWith("Daily incentive:")));
  const incentiveText = incentiveNotes.length ? ` ${incentiveNotes.join(" ")}` : "";
  if (status === "verified_shortfall") {
    return `I checked ${checkedRecords}. Policy amount: ₹${totalExpected}; recorded payout: ₹${totalPaid}; verified shortfall: ₹${shortfall}.${incentiveText} No payment was made in this step.`;
  }
  return `I checked ${checkedRecords}. Policy amount: ₹${totalExpected}; recorded payout: ₹${totalPaid}.${incentiveText} The records show no additional amount is due.`;
}

function outcome(
  issueId: string,
  status: ClaimStatus,
  scope: ClaimOutcome["scope"],
  reason: string,
  assessments: PayoutAssessment[] = [],
): ClaimOutcome {
  return {
    issue_id: issueId,
    status,
    scope,
    reason,
    assessments,
    reply: resultReply(status, assessments, reason),
  };
}

export async function investigateIssues(
  pool: Pool,
  riderId: string,
  receivedAt: Date,
  targets: InvestigationTarget[],
): Promise<InvestigationResult> {
  if (targets.length === 0) return { outcomes: [], events: [] };
  const events: InvestigationEvent[] = [];
  const lookupRiderId = canonicalRiderId(riderId);
  const rider = await pool.query<{ rider_id: string }>(
    "SELECT rider_id FROM riders WHERE rider_id = $1",
    [lookupRiderId],
  );
  events.push({
    type: "tool_call",
    name: "rider_record_lookup",
    input: { requested_rider_id: riderId, normalized_rider_id: lookupRiderId },
    output: { found: rider.rowCount === 1, rider_id: rider.rows[0]?.rider_id ?? null },
  });

  if (!rider.rows[0]) {
    const outcomes = targets.map(({ issueId }) => outcome(issueId, "unclear", null, "the rider account was not found"));
    for (const item of outcomes) events.push({ type: "decision", name: "claim_not_verifiable", input: { issue_id: item.issue_id }, output: item });
    return { outcomes, events };
  }

  const canonicalId = rider.rows[0].rider_id;
  const outcomes: ClaimOutcome[] = [];
  for (const target of targets) {
    const { issueId, update } = target;
    if (update.missing_information.includes("issue_details") && update.trip_ids.length === 0 && update.dates.length === 0) {
      outcomes.push(outcome(issueId, "needs_information", null, "issue_details"));
      continue;
    }

    if (update.trip_ids.length > 0) {
      const assessments: PayoutAssessment[] = [];
      let unclearReason: string | null = null;
      for (const tripId of [...new Set(update.trip_ids)]) {
        const tripResult = await pool.query<DbTrip>(
          `SELECT trip_id, rider_id, started_at, status,
                  distance_km::text AS distance_km, surge_multiplier::text AS surge_multiplier
           FROM trips WHERE trip_id = $1`,
          [tripId],
        );
        const row = tripResult.rows[0];
        events.push({
          type: "tool_call",
          name: "trip_record_lookup",
          input: { issue_id: issueId, trip_id: tripId },
          output: row ? { found: true, rider_id: row.rider_id, payout_date: istDate(row.started_at), status: row.status } : { found: false },
        });
        if (!row) {
          unclearReason = `trip ${tripId} was not found`;
          break;
        }
        if (row.rider_id !== canonicalId) {
          unclearReason = `trip ${tripId} is not linked to this rider account`;
          break;
        }
        const trip = toTrip(row);
        const tripDate = istDate(trip.startedAt);
        if (update.dates.length > 0 && !update.dates.includes(tripDate)) {
          unclearReason = `trip ${tripId} does not match the date provided`;
          break;
        }
        if (!disputeIsInWindow(tripDate, receivedAt)) {
          unclearReason = `trip ${tripId} is outside the seven-day review window`;
          break;
        }
        const linesResult = await pool.query<DbPayoutLine>(
          `SELECT line_id, payout_date::text AS payout_date, rider_id, line_type,
                  trip_id, amount_rupees
           FROM payout_lines WHERE rider_id = $1 AND trip_id = $2 ORDER BY line_id`,
          [canonicalId, tripId],
        );
        const lines = linesResult.rows.map(toPayoutLine);
        events.push({
          type: "tool_call",
          name: "trip_payout_lookup",
          input: { issue_id: issueId, rider_id: canonicalId, trip_id: tripId },
          output: { line_count: lines.length, lines },
        });
        assessments.push(assessTrip(trip, lines));
      }
      if (unclearReason) {
        const suspicious = unclearReason.includes("not linked to this rider account");
        outcomes.push(outcome(issueId, suspicious ? "suspicious" : "unclear", "trip", unclearReason, assessments));
        continue;
      }
      const totalShortfall = assessments.reduce((sum, assessment) => sum + assessment.shortfallRupees, 0);
      const status = resultStatus(totalShortfall);
      outcomes.push(outcome(issueId, status, "trip", "trip records and policy were checked", assessments));
      continue;
    }

    const dates = [...new Set(update.dates)];
    if (dates.length === 0) {
      outcomes.push(outcome(issueId, "needs_information", null, "date"));
      continue;
    }

    const assessments: PayoutAssessment[] = [];
    let unclearReason: string | null = null;
    for (const date of dates) {
      if (!disputeIsInWindow(date, receivedAt)) {
        unclearReason = `${date} is outside the seven-day review window`;
        break;
      }
      const dayTripsResult = await pool.query<DbTrip>(
        `SELECT trip_id, rider_id, started_at, status,
                distance_km::text AS distance_km, surge_multiplier::text AS surge_multiplier
         FROM trips
         WHERE rider_id = $1 AND (started_at AT TIME ZONE 'Asia/Kolkata')::date = $2::date
         ORDER BY started_at, trip_id`,
        [canonicalId, date],
      );
      const trips = dayTripsResult.rows.map(toTrip);
      events.push({
        type: "tool_call",
        name: "day_trip_lookup",
        input: { issue_id: issueId, rider_id: canonicalId, payout_date: date },
        output: { trip_count: trips.length, trip_ids: trips.map((trip) => trip.tripId) },
      });
      if (trips.length === 0) {
        unclearReason = `no trip records were found for ${date}`;
        break;
      }
      const dayLinesResult = await pool.query<DbPayoutLine>(
        `SELECT line_id, payout_date::text AS payout_date, rider_id, line_type,
                trip_id, amount_rupees
         FROM payout_lines WHERE rider_id = $1 AND payout_date = $2::date ORDER BY line_id`,
        [canonicalId, date],
      );
      const lines = dayLinesResult.rows.map(toPayoutLine);
      events.push({
        type: "tool_call",
        name: "day_payout_lookup",
        input: { issue_id: issueId, rider_id: canonicalId, payout_date: date },
        output: { line_count: lines.length, lines },
      });
      assessments.push(assessDay(canonicalId, date, trips, lines));
    }
    if (unclearReason) {
      outcomes.push(outcome(issueId, "unclear", "day", unclearReason, assessments));
      continue;
    }
    const totalShortfall = assessments.reduce((sum, assessment) => sum + assessment.shortfallRupees, 0);
    const status = resultStatus(totalShortfall);
    outcomes.push(outcome(issueId, status, "day", "day records and policy were checked", assessments));
  }

  for (const item of outcomes) {
    events.push({
      type: "decision",
      name: "payout_claim_assessed",
      input: { issue_id: item.issue_id, scope: item.scope },
      output: {
        status: item.status,
        reason: item.reason,
        expected_rupees: item.assessments.reduce((sum, assessment) => sum + assessment.expectedRupees, 0),
        historical_paid_rupees: item.assessments.reduce((sum, assessment) => sum + assessment.historicalPaidRupees, 0),
        shortfall_rupees: item.assessments.reduce((sum, assessment) => sum + assessment.shortfallRupees, 0),
        breakdown: item.assessments.flatMap((assessment) => assessment.breakdown),
      },
    });
  }
  return { outcomes, events };
}

export function appendInvestigationContext(
  state: { issues: Record<string, unknown>[]; [key: string]: unknown },
  outcomes: ClaimOutcome[],
): typeof state {
  if (outcomes.length === 0) return state;
  // Keep monetary evidence in persisted state, outside the issue context sent to Groq.
  return { ...state, latest_investigations: outcomes };
}
