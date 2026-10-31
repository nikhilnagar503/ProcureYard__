import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { Decimal } from "decimal.js";
import { PayoutLine, ReferenceDataError, TripRecord, tripPayoutDate } from "../../domain/payouts.js";

export interface RiderRecord {
  riderId: string;
  name: string;
  city: string;
  joinedOn: string;
}

export interface ReferenceData {
  riders: Map<string, RiderRecord>;
  trips: TripRecord[];
  tripsById: Map<string, TripRecord>;
  payoutLines: PayoutLine[];
}

type CsvRow = Record<string, string>;

function rows(file: string): CsvRow[] {
  try {
    return parse(readFileSync(file), { columns: true, skip_empty_lines: true, trim: true });
  } catch (error) {
    throw new ReferenceDataError(`Could not read CSV ${file}: ${String(error)}`);
  }
}

function parseDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ReferenceDataError(`Invalid ${field}: ${value}`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ReferenceDataError(`Invalid ${field}: ${value}`);
  }
  return value;
}

function parseTimestamp(value: string, field: string): Date {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new ReferenceDataError(`${field} must include a timezone: ${value}`);
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new ReferenceDataError(`Invalid ${field}: ${value}`);
  return result;
}

function parseDecimal(value: string, field: string): string {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new ReferenceDataError(`Invalid ${field}: ${value}`);
  }
  if (!parsed.isFinite()) throw new ReferenceDataError(`Invalid ${field}: ${value}`);
  return parsed.toString();
}

function matchRiderId(value: string, riderIds: Set<string>): string {
  const riderId = value.trim();
  if (riderIds.has(riderId)) return riderId;
  const match = /^R(\d+)$/i.exec(riderId);
  if (match) {
    const candidate = `R${Number(match[1]).toString().padStart(3, "0")}`;
    if (riderIds.has(candidate)) return candidate;
  }
  return riderId;
}

function sameTrip(a: TripRecord, b: TripRecord): boolean {
  return a.tripId === b.tripId && a.riderId === b.riderId && a.startedAt.getTime() === b.startedAt.getTime()
    && a.status === b.status && new Decimal(a.distanceKm).equals(b.distanceKm)
    && new Decimal(a.surgeMultiplier).equals(b.surgeMultiplier);
}

export function loadReferenceData(dataDirectory: string): ReferenceData {
  const root = path.resolve(dataDirectory);
  const riders = new Map<string, RiderRecord>();
  for (const row of rows(path.join(root, "riders.csv"))) {
    const riderId = row.rider_id?.trim() ?? "";
    if (!riderId || riders.has(riderId)) throw new ReferenceDataError(`Missing or duplicate rider_id ${riderId}`);
    riders.set(riderId, {
      riderId,
      name: row.name.trim(),
      city: row.city.trim(),
      joinedOn: parseDate(row.joined_on, "joined_on"),
    });
  }

  const riderIds = new Set(riders.keys());
  const tripsById = new Map<string, TripRecord>();
  for (const row of rows(path.join(root, "trips.csv"))) {
    const trip: TripRecord = {
      tripId: row.trip_id.trim(),
      riderId: matchRiderId(row.rider_id, riderIds),
      startedAt: parseTimestamp(row.started_at, "started_at"),
      status: row.status as TripRecord["status"],
      distanceKm: parseDecimal(row.distance_km, "distance_km"),
      surgeMultiplier: parseDecimal(row.surge_multiplier, "surge_multiplier"),
    };
    if (!trip.tripId || !["completed", "cancelled_by_rider", "cancelled_by_customer"].includes(trip.status)) {
      throw new ReferenceDataError(`Invalid trip ${trip.tripId}`);
    }
    if (new Decimal(trip.distanceKm).isNegative() || new Decimal(trip.surgeMultiplier).isNegative()) {
      throw new ReferenceDataError(`Negative trip input for ${trip.tripId}`);
    }
    if (!riders.has(trip.riderId)) throw new ReferenceDataError(`Unknown rider ${trip.riderId} on trip ${trip.tripId}`);
    const existing = tripsById.get(trip.tripId);
    if (existing) {
      if (!sameTrip(existing, trip)) throw new ReferenceDataError(`Conflicting duplicate trip_id ${trip.tripId}`);
      continue;
    }
    tripsById.set(trip.tripId, trip);
  }

  const payoutLines: PayoutLine[] = rows(path.join(root, "payout_lines.csv")).map((row) => {
    const riderId = matchRiderId(row.rider_id, riderIds);
    const tripId = row.trip_id.trim() || null;
    if (!riders.has(riderId)) throw new ReferenceDataError(`Unknown rider ${riderId} in payout_lines.csv`);
    if (tripId && !tripsById.has(tripId)) throw new ReferenceDataError(`Unknown trip ${tripId} in payout_lines.csv`);
    const amount = Number(row.amount);
    if (!Number.isSafeInteger(amount)) throw new ReferenceDataError(`Invalid payout amount ${row.amount}`);
    return {
      lineId: row.line_id.trim(),
      payoutDate: parseDate(row.payout_date, "payout_date"),
      riderId,
      lineType: row.line_type.trim(),
      tripId,
      amountRupees: amount,
    };
  });

  return { riders, trips: [...tripsById.values()], tripsById, payoutLines };
}

export function tripsForDay(data: ReferenceData, riderId: string, payoutDate: string): TripRecord[] {
  return data.trips.filter((trip) => trip.riderId === riderId && tripPayoutDate(trip) === payoutDate);
}

export function payoutLinesForDay(data: ReferenceData, riderId: string, payoutDate: string): PayoutLine[] {
  return data.payoutLines.filter((line) => line.riderId === riderId && line.payoutDate === payoutDate);
}
