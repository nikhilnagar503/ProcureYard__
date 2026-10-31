import "dotenv/config";
import path from "node:path";
import { createApp } from "./app.js";
import { ensureSchema, importReferenceData, pool } from "./infrastructure/database/db.js";
import { loadReferenceData } from "./infrastructure/reference-data/csv-loader.js";
import { GroqMessageUnderstander } from "./infrastructure/llm/groq-client.js";

async function start(): Promise<void> {
  await pool.query("SELECT 1");
  await ensureSchema();
  const dataDirectory = process.env.DATA_DIR ?? path.resolve(process.cwd(), "data");
  const referenceData = loadReferenceData(dataDirectory);
  const counts = await importReferenceData(referenceData);
  console.info("Reference data ready", counts);

  const app = createApp(pool, new GroqMessageUnderstander());
  const port = Number(process.env.PORT ?? "8000");
  const server = app.listen(port, "0.0.0.0", () => {
    console.info(`Rider Payout Dispute Desk listening on port ${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

start().catch(async (error: unknown) => {
  console.error("Application startup failed", error);
  await pool.end();
  process.exitCode = 1;
});
