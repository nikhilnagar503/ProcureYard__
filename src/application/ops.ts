import { Pool } from "pg";

export interface PendingOpsItem {
  id: string;
  rider_id: string;
  type: "approval" | "escalation";
  amount: number | null;
  reason: string;
  created_at: Date;
}

export async function getPendingOpsItems(pool: Pool): Promise<PendingOpsItem[]> {
  const result = await pool.query<PendingOpsItem>(
    `SELECT id, rider_id, item_type AS type, amount_rupees AS amount, reason, created_at
     FROM ops_items WHERE status = 'pending' ORDER BY created_at ASC, id ASC`,
  );
  return result.rows;
}
