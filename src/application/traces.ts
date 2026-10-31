import { Pool } from "pg";

export interface TraceStep {
  at: Date;
  type: string;
  name: string;
  input: unknown;
  output: unknown;
}

export async function getRiderTrace(pool: Pool, riderId: string): Promise<TraceStep[]> {
  const result = await pool.query<{
    at: Date;
    type: string;
    name: string;
    input: unknown;
    output: unknown;
  }>(
    `SELECT created_at AS at, event_type AS type, name,
            input_data AS input, output_data AS output
     FROM trace_events WHERE rider_id = $1 ORDER BY created_at ASC, id ASC`,
    [riderId],
  );
  return result.rows;
}
