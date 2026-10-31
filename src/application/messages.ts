import { randomUUID } from "node:crypto";
import { Pool, PoolClient } from "pg";
import {
  appendInvestigationContext,
  InvestigationEvent,
  InvestigationTarget,
  investigateIssues,
} from "./claims.js";
import { decideClaimPaths } from "./decisions.js";
import { executeEligiblePayments, hasUnresolvedPaySwiftPayment, reconcilePaySwiftLedger } from "./payments.js";
import { PaySwiftClient } from "../infrastructure/payswift/client.js";
import {
  GroqMessageUnderstander,
  IssueUpdate,
  LanguageUnderstandingUnavailable,
  MessageUnderstanding,
  RecentMessage,
  sanitizeUnderstanding,
} from "../infrastructure/llm/groq-client.js";

export class MessageIdConflict extends Error {}
export class StoredMessageUnavailable extends Error {}
export class MessageUnderstandingUnavailable extends Error {}

interface StoredInboundMessage {
  rider_id: string;
  text: string;
  received_at: Date;
  reply: string | null;
  processing_status: string;
}

export async function receiveMessage(
  pool: Pool,
  understander: GroqMessageUnderstander,
  args: { messageId: string; riderId: string; text: string; receivedAt: Date },
  paySwift: PaySwiftClient = new PaySwiftClient(),
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO inbound_messages (message_id, rider_id, text, received_at, reply, processing_status)
       VALUES ($1, $2, $3, $4, NULL, 'processing')
       ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
      [args.messageId, args.riderId, args.text, args.receivedAt],
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query<StoredInboundMessage>(
        `SELECT rider_id, text, received_at, reply, processing_status
         FROM inbound_messages WHERE message_id = $1 FOR UPDATE`,
        [args.messageId],
      );
      const stored = existing.rows[0];
      if (!stored) throw new StoredMessageUnavailable("A duplicate message could not be loaded.");
      if (stored.rider_id !== args.riderId || stored.text !== args.text || stored.received_at.getTime() !== args.receivedAt.getTime()) {
        throw new MessageIdConflict("message_id has already been used for different message content.");
      }
      if (stored.processing_status === "processed" && stored.reply !== null) {
        await client.query("COMMIT");
        return stored.reply;
      }
      if (stored.processing_status === "processing") {
        throw new StoredMessageUnavailable("The earlier copy of this message is still being processed.");
      }
      await client.query(
        `UPDATE inbound_messages SET processing_status = 'processing', reply = NULL WHERE message_id = $1`,
        [args.messageId],
      );
    } else {
      await addTrace(client, args.riderId, "message_in", "inbound_message", {
        message_id: args.messageId,
        text: args.text,
        received_at: args.receivedAt.toISOString(),
      }, null);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  try {
    const { state, recentMessages } = await loadContext(pool, args.riderId, args.messageId);
    let ledgerAvailable = true;
    let ledgerEvents: InvestigationEvent[] = [];
    let reconciliationAttempted = false;
    if (await hasUnresolvedPaySwiftPayment(pool, args.riderId)) {
      reconciliationAttempted = true;
      try {
        const reconciliation = await reconcilePaySwiftLedger(pool, args.riderId, paySwift);
        ledgerEvents = reconciliation.events;
      } catch (error) {
        ledgerAvailable = false;
        ledgerEvents = [{
          type: "error",
          name: "payswift_ledger_reconciliation_failed",
          input: { rider_id: args.riderId, reason: "unresolved_payment_follow_up" },
          output: { error: error instanceof Error ? error.message : "unknown PaySwift ledger error", payment_blocked: true },
        }];
      }
      if (ledgerEvents.some((event) => event.type === "error")) await persistEvents(pool, args.riderId, ledgerEvents);
    }
    const modelResult = await understander.understand({
      riderId: args.riderId,
      text: args.text,
      receivedAt: args.receivedAt,
      existingIssues: modelIssueContext(state.issues),
      recentMessages,
    });
    const result = sanitizeUnderstanding(modelResult, {
      text: args.text,
      riderId: args.riderId,
      receivedAt: args.receivedAt,
    });
    await addTraceToPool(pool, args.riderId, "model", "groq_message_understanding", {
      message_id: args.messageId,
      active_issue_ids: state.issues.map((issue) => issue.issue_id ?? null),
    }, result);
    const applied = applyUpdates(state, result, args.messageId, args.receivedAt);
    const investigation = await investigateIssues(pool, args.riderId, args.receivedAt, applied.targets);
    await persistEvents(pool, args.riderId, investigation.events);
    const verifiedClaimsExist = investigation.outcomes.some((item) => item.status === "verified_shortfall");
    if (verifiedClaimsExist && !reconciliationAttempted) {
      reconciliationAttempted = true;
      try {
        const reconciliation = await reconcilePaySwiftLedger(pool, args.riderId, paySwift);
        ledgerEvents.push(...reconciliation.events);
      } catch (error) {
        ledgerAvailable = false;
        ledgerEvents = [{
          type: "error",
          name: "payswift_ledger_reconciliation_failed",
          input: { rider_id: args.riderId },
          output: { error: error instanceof Error ? error.message : "unknown PaySwift ledger error", payment_blocked: true },
        }];
      }
      if (ledgerEvents.some((event) => event.type === "error")) await persistEvents(pool, args.riderId, ledgerEvents);
    }
    const decisions = await decideClaimPaths(pool, args.riderId, investigation.outcomes, {
      messageId: args.messageId,
      identityMismatch: result.identity_mismatch,
      paymentProviderAvailable: ledgerAvailable,
    });
    await persistEvents(pool, args.riderId, decisions.events);
    const payments = await executeEligiblePayments(pool, args.riderId, decisions.outcomes, paySwift);
    await persistEvents(pool, args.riderId, payments.events);
    const updatedState = appendInvestigationContext(applied.state, decisions.outcomes);
    const reply = decisions.identityMismatchReply ?? (decisions.outcomes.length > 0
      ? decisions.outcomes.map((item) => item.reply).join(" ")
      : result.reply);
    await saveCompletedMessage(pool, args, reply, updatedState);
    return reply;
  } catch (error) {
    await markFailed(pool, args.messageId, args.riderId,
      error instanceof LanguageUnderstandingUnavailable ? "language_understanding_unavailable" : "message_processing_failed");
    if (error instanceof LanguageUnderstandingUnavailable) {
      throw new MessageUnderstandingUnavailable("Message understanding is temporarily unavailable.", { cause: error });
    }
    throw error;
  }
}

interface ConversationState {
  issues: Record<string, unknown>[];
  [key: string]: unknown;
}

async function loadContext(pool: Pool, riderId: string, currentMessageId: string): Promise<{
  state: ConversationState;
  recentMessages: RecentMessage[];
}> {
  const [conversation, history] = await Promise.all([
    pool.query<{ state: unknown }>("SELECT state FROM conversations WHERE rider_id = $1", [riderId]),
    pool.query<{ received_at: Date; text: string; reply: string | null }>(
      `SELECT received_at, text, reply FROM inbound_messages
       WHERE rider_id = $1 AND message_id <> $2 AND processing_status = 'processed'
       ORDER BY received_at DESC, message_id DESC LIMIT 8`,
      [riderId, currentMessageId],
    ),
  ]);
  const rawState = conversation.rows[0]?.state;
  const stateObject = rawState && typeof rawState === "object" && !Array.isArray(rawState)
    ? rawState as Record<string, unknown> : {};
  const rawIssues = Array.isArray(stateObject.issues) ? stateObject.issues : [];
  return {
    state: { ...stateObject, issues: rawIssues.filter(isJsonObject) },
    recentMessages: history.rows.reverse().map((row) => ({
      received_at: row.received_at.toISOString(),
      rider_message: row.text,
      // Replies may contain deterministic payout amounts; keep them out of Groq context.
      agent_reply: "",
    })),
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelIssueContext(issues: Record<string, unknown>[]): Record<string, unknown>[] {
  const allowed = [
    "issue_id", "issue_type", "summary", "trip_ids", "dates",
    "missing_information", "follow_up_question",
  ];
  return issues.map((issue) => Object.fromEntries(
    allowed.filter((key) => key in issue).map((key) => [key, issue[key]]),
  ));
}

function applyUpdates(
  state: ConversationState,
  result: MessageUnderstanding,
  messageId: string,
  receivedAt: Date,
): { state: ConversationState; targets: InvestigationTarget[] } {
  const issues = [...state.issues];
  const targets: InvestigationTarget[] = [];
  if (!result.identity_mismatch) {
    for (const update of result.updates) {
      const issue = issueState(update, receivedAt);
      if (update.action === "create" && update.issue_id === null) {
        const issueId = randomUUID();
        issues.push({ issue_id: issueId, ...issue });
        targets.push({ issueId, update });
      } else if (update.action === "update" && update.issue_id) {
        const index = issues.findIndex((existing) => existing.issue_id === update.issue_id);
        if (index >= 0) {
          issues[index] = { issue_id: update.issue_id, ...issue };
          targets.push({ issueId: update.issue_id, update });
        }
      }
    }
  }
  return {
    state: { ...state, issues, last_message_id: messageId, updated_at: receivedAt.toISOString() },
    targets,
  };
}

function issueState(update: IssueUpdate, receivedAt: Date): Record<string, unknown> {
  return {
    issue_type: update.issue_type,
    summary: update.summary,
    trip_ids: update.trip_ids,
    dates: update.dates,
    missing_information: update.missing_information,
    follow_up_question: update.follow_up_question,
    updated_at: receivedAt.toISOString(),
  };
}

async function saveCompletedMessage(
  pool: Pool,
  args: { messageId: string; riderId: string },
  reply: string,
  updatedState: ConversationState,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO conversations (rider_id, state) VALUES ($1, $2::jsonb)
       ON CONFLICT (rider_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
      [args.riderId, JSON.stringify(updatedState)],
    );
    await client.query(
      `UPDATE inbound_messages SET reply = $2, processing_status = 'processed' WHERE message_id = $1`,
      [args.messageId, reply],
    );
    await addTrace(client, args.riderId, "decision", "conversation_context_updated", {
      message_id: args.messageId,
    }, updatedState);
    await addTrace(client, args.riderId, "reply", "rider_follow_up", null, reply);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markFailed(pool: Pool, messageId: string, riderId: string, errorCode: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE inbound_messages SET processing_status = 'failed', reply = NULL WHERE message_id = $1`,
      [messageId],
    );
    await addTrace(client, riderId, "error", errorCode === "language_understanding_unavailable" ? "model_extraction_failed" : "message_processing_failed",
      { message_id: messageId }, { error: errorCode });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistEvents(pool: Pool, riderId: string, events: InvestigationEvent[]): Promise<void> {
  for (const event of events) {
    await addTraceToPool(pool, riderId, event.type, event.name, event.input, event.output);
  }
}

async function addTraceToPool(pool: Pool, riderId: string, eventType: string, name: string, input: unknown, output: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO trace_events (rider_id, event_type, name, input_data, output_data)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [riderId, eventType, name, input === null ? null : JSON.stringify(input), output === null ? null : JSON.stringify(output)],
  );
}

async function addTrace(
  client: PoolClient,
  riderId: string,
  eventType: string,
  name: string,
  input: unknown,
  output: unknown,
): Promise<void> {
  await client.query(
    `INSERT INTO trace_events (rider_id, event_type, name, input_data, output_data)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [riderId, eventType, name, input === null ? null : JSON.stringify(input), output === null ? null : JSON.stringify(output)],
  );
}
