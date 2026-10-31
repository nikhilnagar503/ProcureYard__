import { Decimal } from "decimal.js";

export const IST = "Asia/Kolkata";

export interface PayoutPolicy {
  baseFareRupees: Decimal;
  includedDistanceKm: Decimal;
  rupeesPerExtraKm: Decimal;
  dailyIncentiveRupees: number;
  incentiveTripThreshold: number;
  riderCancellationPenaltyRupees: number;
  disputeWindowCalendarDays: number;
}

export const DEFAULT_POLICY: PayoutPolicy = {
  baseFareRupees: new Decimal(25),
  includedDistanceKm: new Decimal(2),
  rupeesPerExtraKm: new Decimal(6),
  dailyIncentiveRupees: 150,
  incentiveTripThreshold: 12,
  riderCancellationPenaltyRupees: 10,
  disputeWindowCalendarDays: 7,
};

export interface TripRecord {
  tripId: string;
  riderId: string;
  startedAt: Date;
  status: "completed" | "cancelled_by_rider" | "cancelled_by_customer";
  distanceKm: string;
  surgeMultiplier: string;
}

export interface PayoutLine {
  lineId: string;
  payoutDate: string;
  riderId: string;
  lineType: string;
  tripId: string | null;
  amountRupees: number;
}

export interface PayoutAssessment {
  riderId: string;
  payoutDate: string;
  scope: "trip" | "day";
  tripId: string | null;
  expectedRupees: number;
  historicalPaidRupees: number;
  shortfallRupees: number;
  breakdown: string[];
}

export class ReferenceDataError extends Error {}

export function istDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
}

export function tripPayoutDate(trip: TripRecord): string {
  return istDate(trip.startedAt);
}

export function tripFareRupees(trip: TripRecord, policy = DEFAULT_POLICY): number {
  const extraKm = Decimal.max(new Decimal(trip.distanceKm).minus(policy.includedDistanceKm), 0);
  return policy.baseFareRupees
    .plus(extraKm.mul(policy.rupeesPerExtraKm))
    .mul(new Decimal(trip.surgeMultiplier))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export function disputeIsInWindow(
  tripDate: string,
  receivedAt: Date,
  policy = DEFAULT_POLICY,
): boolean {
  const endDate = istDate(receivedAt);
  const [year, month, day] = endDate.split("-").map(Number);
  const startDate = new Date(Date.UTC(year!, month! - 1, day! - (policy.disputeWindowCalendarDays - 1)))
    .toISOString().slice(0, 10);
  return startDate <= tripDate && tripDate <= endDate;
}

export function assessTrip(
  trip: TripRecord,
  payoutLines: PayoutLine[],
  policy = DEFAULT_POLICY,
): PayoutAssessment {
  const paid = payoutLines
    .filter((line) => line.riderId === trip.riderId && line.tripId === trip.tripId)
    .reduce((total, line) => total + line.amountRupees, 0);
  let expected: number;
  let fact: string;

  if (trip.status === "completed") {
    expected = tripFareRupees(trip, policy);
    fact = `Trip ${trip.tripId}: ${trip.distanceKm} km at ${trip.surgeMultiplier}x; policy fare ₹${expected}; historical trip payout ₹${paid}.`;
  } else if (trip.status === "cancelled_by_rider") {
    expected = -policy.riderCancellationPenaltyRupees;
    fact = `Trip ${trip.tripId} was rider-cancelled; policy penalty is ₹${policy.riderCancellationPenaltyRupees}; historical penalty line total ₹${paid}.`;
  } else {
    expected = 0;
    fact = `Trip ${trip.tripId} was customer-cancelled; policy fare and penalty are ₹0.`;
  }

  return {
    riderId: trip.riderId,
    payoutDate: tripPayoutDate(trip),
    scope: "trip",
    tripId: trip.tripId,
    expectedRupees: expected,
    historicalPaidRupees: paid,
    shortfallRupees: expected - paid,
    breakdown: [fact],
  };
}

export function assessDay(
  riderId: string,
  payoutDate: string,
  trips: TripRecord[],
  payoutLines: PayoutLine[],
  policy = DEFAULT_POLICY,
): PayoutAssessment {
  const dayTrips = trips.filter((trip) => trip.riderId === riderId && tripPayoutDate(trip) === payoutDate);
  const dayLines = payoutLines.filter((line) => line.riderId === riderId && line.payoutDate === payoutDate);
  let expected = 0;
  let completedCount = 0;
  const breakdown: string[] = [];

  for (const trip of dayTrips) {
    if (trip.status === "completed") {
      const fare = tripFareRupees(trip, policy);
      completedCount += 1;
      expected += fare;
      breakdown.push(`${trip.tripId}: completed fare ₹${fare}.`);
    } else if (trip.status === "cancelled_by_rider") {
      expected -= policy.riderCancellationPenaltyRupees;
      breakdown.push(`${trip.tripId}: rider cancellation penalty −₹${policy.riderCancellationPenaltyRupees}.`);
    } else {
      breakdown.push(`${trip.tripId}: customer cancellation, ₹0.`);
    }
  }

  if (completedCount >= policy.incentiveTripThreshold) {
    expected += policy.dailyIncentiveRupees;
    breakdown.push(`Daily incentive: ${completedCount} completed trips; ₹${policy.dailyIncentiveRupees} earned.`);
  } else {
    breakdown.push(`Daily incentive: ${completedCount} completed trips; ${policy.incentiveTripThreshold} required.`);
  }
  const paid = dayLines.reduce((total, line) => total + line.amountRupees, 0);
  breakdown.push(`Historical payout lines for the day total ₹${paid}.`);

  return {
    riderId,
    payoutDate,
    scope: "day",
    tripId: null,
    expectedRupees: expected,
    historicalPaidRupees: paid,
    shortfallRupees: expected - paid,
    breakdown,
  };
}
