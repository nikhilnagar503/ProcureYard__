export interface PaySwiftPayout {
  payout_id: string;
  rider_id: string;
  amount: number;
  reference: string;
  status: string;
  created_at: Date | null;
  raw: Record<string, unknown>;
}

export interface PaySwiftPayoutRequest {
  rider_id: string;
  amount: number;
  reference: string;
}

export class PaySwiftError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly uncertain: boolean,
  ) {
    super(message);
    this.name = "PaySwiftError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function parsePayout(value: unknown, requestedRiderId?: string, requestedAmount?: number, requestedReference = ""): PaySwiftPayout {
  const row = object(value);
  const payoutId = row?.payout_id ?? row?.id;
  const riderId = row?.rider_id ?? requestedRiderId;
  const amount = row?.amount ?? row?.amount_rupees ?? requestedAmount;
  const status = row?.status;
  const reference = row?.reference ?? requestedReference;
  const rawCreatedAt = row?.created_at ?? row?.createdAt ?? row?.timestamp;
  const createdAt = typeof rawCreatedAt === "string" || typeof rawCreatedAt === "number"
    ? new Date(rawCreatedAt) : null;
  if (typeof payoutId !== "string" || !payoutId || typeof riderId !== "string" || !riderId ||
      !Number.isInteger(Number(amount)) || Number(amount) < 1 || typeof status !== "string" || !status ||
      (createdAt && Number.isNaN(createdAt.getTime()))) {
    throw new PaySwiftError("PaySwift returned a payout record in an unsupported format.", null, false, true);
  }
  return {
    payout_id: payoutId,
    rider_id: riderId,
    amount: Number(amount),
    reference: typeof reference === "string" ? reference : "",
    status,
    created_at: createdAt,
    raw: row!,
  };
}

export class PaySwiftClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.PAYSWIFT_BASE_URL ?? "http://localhost:8081").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? Number(process.env.PAYSWIFT_TIMEOUT_MS ?? "1000");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private readonly fetchImpl: typeof fetch;

  async listPayouts(riderId: string): Promise<PaySwiftPayout[]> {
    const response = await this.request(`/v1/payouts?rider_id=${encodeURIComponent(riderId)}`, { method: "GET" });
    const body = await this.readBody(response);
    if (!response.ok) {
      throw new PaySwiftError(`PaySwift ledger returned HTTP ${response.status}.`, response.status, false, true);
    }
    const ledgerBody = object(body);
    const candidate = Array.isArray(body) ? body : ledgerBody?.payouts ?? ledgerBody?.data;
    if (!Array.isArray(candidate)) {
      throw new PaySwiftError("PaySwift ledger response did not contain a payouts list.", response.status, false, true);
    }
    return candidate.map((row) => parsePayout(row, riderId));
  }

  async createPayout(request: PaySwiftPayoutRequest, idempotencyKey: string): Promise<{ payout: PaySwiftPayout; raw: unknown }> {
    const response = await this.request("/v1/payouts", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(request),
    });
    const body = await this.readBody(response);
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const uncertain = retryable || response.status === 409;
      throw new PaySwiftError(`PaySwift rejected the payout request with HTTP ${response.status}.`, response.status, retryable, uncertain);
    }
    const responseBody = object(body);
    const payout = parsePayout(responseBody?.data ?? body, request.rider_id, request.amount, request.reference);
    if (payout.rider_id !== request.rider_id || payout.amount !== request.amount) {
      throw new PaySwiftError("PaySwift payout response did not match the requested rider and amount.", response.status, false, true);
    }
    return { payout, raw: body };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      throw new PaySwiftError(`PaySwift request failed: ${message}`, null, true, true);
    }
  }

  private async readBody(response: Response): Promise<unknown> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok && !(body && typeof body === "object")) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new PaySwiftError(`PaySwift returned HTTP ${response.status}.`, response.status, retryable, retryable);
    }
    return body;
  }
}
