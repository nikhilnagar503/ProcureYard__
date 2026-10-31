import express, { NextFunction, Request, Response } from "express";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { Pool } from "pg";
import {
  MessageIdConflict,
  MessageUnderstandingUnavailable,
  receiveMessage,
  StoredMessageUnavailable,
} from "./application/messages.js";
import { approveOpsItem, getOpsConversation, getOpsConversations, getPendingOpsItems, OpsActionError, rejectOpsItem } from "./application/ops.js";
import { getRiderTrace } from "./application/traces.js";
import { openApiSpec } from "./api/openapi.js";
import { GroqMessageUnderstander } from "./infrastructure/llm/groq-client.js";
import { PaySwiftClient } from "./infrastructure/payswift/client.js";

const inboundMessageSchema = z.object({
  message_id: z.string().trim().min(1).max(255),
  rider_id: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1),
  received_at: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
}).strict();

const opsActionSchema = z.object({
  reviewer: z.string().trim().min(1).max(80),
  note: z.string().trim().max(1000).optional().default(""),
}).strict();

function validOpsKey(request: Request): boolean {
  const expected = process.env.OPS_API_KEY ?? "";
  const supplied = request.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (expected.length < 16 || supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function createApp(pool: Pool, understander: GroqMessageUnderstander, paySwift = new PaySwiftClient()): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

  app.get("/ops", (_request, response) => {
    response.sendFile(path.resolve(process.cwd(), "src/templates/ops.html"));
  });

  app.get("/health", async (_request, response, next) => {
    try {
      await pool.query("SELECT 1");
      response.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/messages", async (request, response, next) => {
    const parsed = inboundMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(422).json({ detail: parsed.error.issues });
      return;
    }
    try {
      const reply = await receiveMessage(pool, understander, {
        messageId: parsed.data.message_id,
        riderId: parsed.data.rider_id,
        text: parsed.data.text,
        receivedAt: parsed.data.received_at,
      }, paySwift);
      response.json({ reply });
    } catch (error) {
      if (error instanceof MessageIdConflict) {
        response.status(409).json({ detail: error.message });
      } else if (error instanceof StoredMessageUnavailable || error instanceof MessageUnderstandingUnavailable) {
        response.status(503).json({ detail: "message response temporarily unavailable" });
      } else {
        next(error);
      }
    }
  });

  app.get("/trace/:rider_id", async (request, response, next) => {
    try {
      response.json(await getRiderTrace(pool, request.params.rider_id!));
    } catch (error) {
      next(error);
    }
  });

  app.get("/ops/pending", async (_request, response, next) => {
    try {
      response.json(await getPendingOpsItems(pool));
    } catch (error) {
      next(error);
    }
  });

  app.get("/ops/conversations", async (_request, response, next) => {
    try {
      response.json(await getOpsConversations(pool));
    } catch (error) {
      next(error);
    }
  });

  app.get("/ops/conversations/:rider_id", async (request, response, next) => {
    try {
      const conversation = await getOpsConversation(pool, request.params.rider_id!);
      if (!conversation) {
        response.status(404).json({ detail: "Rider conversation was not found." });
        return;
      }
      response.json(conversation);
    } catch (error) {
      next(error);
    }
  });

  app.post("/ops/:id/approve", async (request, response, next) => {
    if (!validOpsKey(request)) {
      response.status(401).json({ detail: "A valid local operations API key is required." });
      return;
    }
    const parsed = opsActionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(422).json({ detail: parsed.error.issues });
      return;
    }
    try {
      response.json(await approveOpsItem(pool, request.params.id!, parsed.data.reviewer, paySwift));
    } catch (error) {
      if (error instanceof OpsActionError) response.status(error.httpStatus).json({ detail: error.message });
      else next(error);
    }
  });

  app.post("/ops/:id/reject", async (request, response, next) => {
    if (!validOpsKey(request)) {
      response.status(401).json({ detail: "A valid local operations API key is required." });
      return;
    }
    const parsed = opsActionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(422).json({ detail: parsed.error.issues });
      return;
    }
    try {
      response.json(await rejectOpsItem(pool, request.params.id!, parsed.data.reviewer, parsed.data.note));
    } catch (error) {
      if (error instanceof OpsActionError) response.status(error.httpStatus).json({ detail: error.message });
      else next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    console.error("Request failed", error);
    response.status(503).json({ detail: "service temporarily unavailable" });
  });
  return app;
}
