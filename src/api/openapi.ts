export const openApiSpec = {
  openapi: "3.0.3",
  info: { title: "Rider Payout Dispute Desk", version: "0.1.0" },
  paths: {
    "/health": {
      get: { summary: "Check service and database readiness", responses: { "200": { description: "Ready" } } },
    },
    "/messages": {
      post: {
        summary: "Receive a rider message and return the agent reply",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/InboundMessage" } } },
        },
        responses: {
          "200": { description: "Agent reply", content: { "application/json": { schema: { $ref: "#/components/schemas/MessageReply" } } } },
          "409": { description: "Message ID was reused with different content" },
          "503": { description: "Database or Groq service is unavailable" },
        },
      },
    },
    "/trace/{rider_id}": {
      get: {
        summary: "Read a rider's agent trace",
        parameters: [{ name: "rider_id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Ordered trace steps" } },
      },
    },
    "/ops/pending": { get: { summary: "List pending ops items", responses: { "200": { description: "Pending approvals and escalations" } } } },
    "/ops/conversations": { get: { summary: "List recent rider conversations", responses: { "200": { description: "Latest rider messages and saved context" } } } },
    "/ops/{id}/approve": {
      post: {
        summary: "Approve and send the already verified claim amount",
        description: "Requires Authorization: Bearer <OPS_API_KEY>. The amount is read from persisted claim evidence; it cannot be changed by the request. Provider retries reuse the stable claim idempotency key.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OpsAction" } } } },
        responses: { "200": { description: "Provider outcome" }, "401": { description: "Operations key required" }, "409": { description: "Claim evidence or item state is not payable" } },
      },
    },
    "/ops/{id}/reject": {
      post: {
        summary: "Reject a pending operations item",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/OpsAction" } } } },
        responses: { "200": { description: "Item rejected and traced" }, "401": { description: "Operations key required" } },
      },
    },
  },
  components: {
    schemas: {
      InboundMessage: {
        type: "object",
        required: ["message_id", "rider_id", "text", "received_at"],
        properties: {
          message_id: { type: "string" },
          rider_id: { type: "string" },
          text: { type: "string" },
          received_at: { type: "string", format: "date-time", example: "2026-09-22T09:05:00+05:30" },
        },
        additionalProperties: false,
      },
      MessageReply: { type: "object", required: ["reply"], properties: { reply: { type: "string" } } },
      OpsAction: {
        type: "object", required: ["reviewer"], additionalProperties: false,
        properties: { reviewer: { type: "string", example: "Nikhil" }, note: { type: "string", example: "Reviewed reference payout evidence." } },
      },
    },
  },
} as const;
