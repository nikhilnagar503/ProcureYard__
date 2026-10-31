import { Pool, PoolClient } from "pg";
import { ReferenceData } from "../reference-data/csv-loader.js";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/procureyard",
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS riders (
  rider_id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  city VARCHAR(120) NOT NULL,
  joined_on DATE NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
  trip_id VARCHAR(64) PRIMARY KEY,
  rider_id VARCHAR(64) NOT NULL REFERENCES riders(rider_id),
  started_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(32) NOT NULL,
  distance_km NUMERIC(10,3) NOT NULL,
  surge_multiplier NUMERIC(8,3) NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_trips_rider_started_at ON trips(rider_id, started_at);
CREATE TABLE IF NOT EXISTS payout_lines (
  line_id VARCHAR(64) PRIMARY KEY,
  payout_date DATE NOT NULL,
  rider_id VARCHAR(64) NOT NULL REFERENCES riders(rider_id),
  line_type VARCHAR(40) NOT NULL,
  trip_id VARCHAR(64) REFERENCES trips(trip_id),
  amount_rupees INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_payout_lines_rider_date ON payout_lines(rider_id, payout_date);
CREATE TABLE IF NOT EXISTS conversations (
  rider_id VARCHAR(64) PRIMARY KEY,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inbound_messages (
  message_id VARCHAR(255) PRIMARY KEY,
  rider_id VARCHAR(64) NOT NULL,
  text TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  reply TEXT,
  processing_status VARCHAR(16) NOT NULL DEFAULT 'processing'
    CHECK (processing_status IN ('processing', 'processed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_inbound_messages_rider_received ON inbound_messages(rider_id, received_at);
CREATE TABLE IF NOT EXISTS trace_events (
  id BIGSERIAL PRIMARY KEY,
  rider_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  name VARCHAR(160) NOT NULL,
  input_data JSONB,
  output_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_trace_events_rider_created ON trace_events(rider_id, created_at);
CREATE TABLE IF NOT EXISTS ops_items (
  id VARCHAR(36) PRIMARY KEY,
  rider_id VARCHAR(64) NOT NULL,
  item_type VARCHAR(16) NOT NULL CHECK (item_type IN ('approval', 'escalation')),
  amount_rupees INTEGER,
  reason TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'resolved')),
  claim JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_ops_items_status_created ON ops_items(status, created_at);
CREATE TABLE IF NOT EXISTS payment_records (
  id VARCHAR(36) PRIMARY KEY,
  rider_id VARCHAR(64) NOT NULL,
  amount_rupees INTEGER NOT NULL,
  reference VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL UNIQUE,
  payswift_payout_id VARCHAR(128) UNIQUE,
  status VARCHAR(24) NOT NULL,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_records_rider_created ON payment_records(rider_id, created_at);
`;

export async function ensureSchema(): Promise<void> {
  await pool.query(SCHEMA_SQL);
}

interface UpsertTable {
  table: string;
  columns: string[];
  conflictColumn: string;
  rows: Array<Array<string | number | Date | null>>;
}

async function upsertRows(client: PoolClient, table: UpsertTable): Promise<void> {
  const batchSize = 500;
  const updates = table.columns.filter((column) => column !== table.conflictColumn);
  for (let offset = 0; offset < table.rows.length; offset += batchSize) {
    const batch = table.rows.slice(offset, offset + batchSize);
    const values: Array<string | number | Date | null> = [];
    const tuples = batch.map((row) => {
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const columns = table.columns.map((column) => `"${column}"`).join(", ");
    const set = updates.map((column) => `"${column}" = EXCLUDED."${column}"`).join(", ");
    const sql = `INSERT INTO "${table.table}" (${columns}) VALUES ${tuples.join(", ")}
      ON CONFLICT ("${table.conflictColumn}") DO UPDATE SET ${set}`;
    await client.query(sql, values);
  }
}

export async function importReferenceData(data: ReferenceData): Promise<{ riders: number; trips: number; payoutLines: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await upsertRows(client, {
      table: "riders",
      columns: ["rider_id", "name", "city", "joined_on"],
      conflictColumn: "rider_id",
      rows: [...data.riders.values()].map((rider) => [rider.riderId, rider.name, rider.city, rider.joinedOn]),
    });
    await upsertRows(client, {
      table: "trips",
      columns: ["trip_id", "rider_id", "started_at", "status", "distance_km", "surge_multiplier"],
      conflictColumn: "trip_id",
      rows: data.trips.map((trip) => [trip.tripId, trip.riderId, trip.startedAt, trip.status, trip.distanceKm, trip.surgeMultiplier]),
    });
    await upsertRows(client, {
      table: "payout_lines",
      columns: ["line_id", "payout_date", "rider_id", "line_type", "trip_id", "amount_rupees"],
      conflictColumn: "line_id",
      rows: data.payoutLines.map((line) => [line.lineId, line.payoutDate, line.riderId, line.lineType, line.tripId, line.amountRupees]),
    });
    await client.query("COMMIT");
    return { riders: data.riders.size, trips: data.trips.length, payoutLines: data.payoutLines.length };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
