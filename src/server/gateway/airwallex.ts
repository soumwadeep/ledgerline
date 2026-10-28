import type { Currency, QuoteRecord, TransferRecord } from "../types";
import { round2 } from "./simulated";
import {
  GatewayError,
  type DepositInput,
  type GatewayContext,
  type MoneyGateway,
  type QuoteInput,
  type TransferInput,
} from "./types";

/**
 * Real Airwallex sandbox client.
 *
 * Written against the endpoint sequence in the Airwallex builder guide and the
 * official API reference. Notes that are baked into this file because they are
 * easy to get wrong:
 *   - The access token from /authentication/login lasts 30 minutes.
 *   - FX calls must NOT carry x-api-version.
 *   - Amounts are major units.
 *   - Every mutating call needs a stable request_id.
 *   - Simulation endpoints only exist against the sandbox host.
 */

const BASE = process.env.AIRWALLEX_BASE_URL ?? "https://api.sandbox.airwallex.com";
const API_VERSION = process.env.AIRWALLEX_API_VERSION ?? "2019-07-12";

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class AirwallexGateway implements MoneyGateway {
  readonly mode = "airwallex" as const;
  private cached: CachedToken | null = null;

  constructor(
    private readonly clientId: string,
    private readonly apiKey: string,
  ) {
    if (!clientId || !apiKey) {
      throw new Error("AirwallexGateway requires AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY");
    }
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now() + 30_000) return this.cached.token;

    const res = await fetch(`${BASE}/api/v1/authentication/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-client-id": this.clientId,
        "x-api-key": this.apiKey,
      },
      body: "{}",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GatewayError(
        `login failed ${res.status}. Check the sandbox business is approved and the key is scoped. ${text.slice(0, 200)}`,
        res.status,
        "login_failed",
      );
    }
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new GatewayError("login returned no token", 500, "no_token");
    // Guide: token lasts 30 minutes. Refresh a little early.
    this.cached = { token: body.token, expiresAt: Date.now() + 29 * 60_000 };
    return this.cached.token;
  }

  private async call<T>(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown; withApiVersion?: boolean; onBehalfOf?: string } = {},
  ): Promise<T> {
    const token = await this.token();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    if (init.withApiVersion !== false) headers["x-api-version"] = API_VERSION;
    if (init.onBehalfOf) headers["x-on-behalf-of"] = init.onBehalfOf;

    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = json as { code?: string; message?: string } | null;
      throw new GatewayError(
        `${init.method ?? "GET"} ${path} -> ${res.status} ${err?.code ?? ""} ${err?.message ?? text.slice(0, 200)}`,
        res.status,
        err?.code ?? "http_error",
      );
    }
    return json as T;
  }

  async describe(): Promise<string> {
    return `Airwallex sandbox ${BASE} (client ${this.clientId.slice(0, 6)}...)`;
  }

  async listBalances(ctx?: GatewayContext): Promise<Record<Currency, number>> {
    const body = await this.call<{
      list?: Array<{ currency?: string; balances?: { available?: Array<{ amount?: number }> } }>;
    }>("/api/v1/balances/current", { onBehalfOf: ctx?.onBehalfOf });

    const out: Record<Currency, number> = {};
    for (const entry of body.list ?? []) {
      if (!entry.currency) continue;
      const amount = entry.balances?.available?.reduce((sum, b) => sum + (b.amount ?? 0), 0) ?? 0;
      out[entry.currency] = amount;
    }
    return out;
  }

  async fxRate(sell: Currency, buy: Currency): Promise<number> {
    const body = await this.call<{
      rates?: Array<{ sell_currency?: string; buy_currency?: string; client_rate?: number }>;
    }>("/api/v1/fx/rates/current", { withApiVersion: false });
    const match = (body.rates ?? []).find(
      (r) => r.sell_currency === sell && r.buy_currency === buy,
    );
    if (!match?.client_rate) {
      throw new GatewayError(`no live rate for ${sell}/${buy}`, 404, "rate_unavailable");
    }
    return match.client_rate;
  }

  async quote(input: QuoteInput): Promise<QuoteRecord> {
    const body = await this.call<{
      id?: string;
      sell_amount?: number;
      buy_amount?: number;
      rate?: number;
    }>("/api/v1/fx/quotes/create", {
      method: "POST",
      withApiVersion: false,
      body: {
        sell_amount: input.sellAmount,
        sell_currency: input.sellCurrency,
        buy_currency: input.buyCurrency,
      },
    });
    if (!body.id) throw new GatewayError("quote created without an id", 500, "quote_no_id");
    return {
      id: body.id,
      from: input.sellCurrency,
      to: input.buyCurrency,
      sell: round2(input.sellAmount),
      buy: round2(body.buy_amount ?? 0),
      rate: body.rate ?? 0,
      usedBy: [],
    };
  }

  async convert(
    quoteId: string,
    requestId: string,
    ctx?: GatewayContext,
  ): Promise<{ conversionId: string; note: string }> {
    // Conversions are REST only. There is no MCP tool for this call.
    const body = await this.call<{ id?: string }>("/api/v1/fx/conversions/create", {
      method: "POST",
      withApiVersion: false,
      onBehalfOf: ctx?.onBehalfOf,
      body: { quote_id: quoteId, request_id: requestId },
    });
    return {
      conversionId: body.id ?? `cnv_${requestId}`,
      note: ctx?.onBehalfOf
        ? `booked on ${ctx.onBehalfOf}`
        : "booked without x-on-behalf-of, so this hit the platform wallet",
    };
  }

  async pay(input: TransferInput): Promise<TransferRecord> {
    const body = await this.call<{
      id?: string;
      status?: string;
      failure_reason?: string;
    }>("/api/v1/transfers/create", {
      method: "POST",
      onBehalfOf: input.onBehalfOf,
      body: {
        request_id: input.requestId,
        currency: input.currency,
        amount: input.amount,
        beneficiary: { id: input.beneficiaryId },
        payment_type: "DOMESTIC_PAYMENT",
        transfer_method: input.transferMethod,
        note: input.note,
      },
    });
    if (!body.id) throw new GatewayError("transfer created without an id", 500, "transfer_no_id");
    return {
      id: body.id,
      requestId: input.requestId,
      obligationId: input.obligationId,
      currency: input.currency,
      amount: input.amount,
      fee: input.transferMethod === "SWIFT" ? 12.85 : 0,
      beneficiaryId: input.beneficiaryId,
      status: mapStatus(body.status),
      failureReason: body.failure_reason,
      createdAt: new Date().toISOString(),
      supersedes: input.supersedes,
    };
  }

  async getTransfer(id: string): Promise<TransferRecord | null> {
    try {
      const body = await this.call<{
        id?: string;
        status?: string;
        currency?: string;
        amount?: number;
        request_id?: string;
        failure_reason?: string;
      }>(`/api/v1/transfers/get?id=${encodeURIComponent(id)}`);
      if (!body.id) return null;
      return {
        id: body.id,
        requestId: body.request_id ?? "",
        currency: body.currency ?? "USD",
        amount: body.amount ?? 0,
        fee: 0,
        beneficiaryId: "",
        status: mapStatus(body.status),
        failureReason: body.failure_reason,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof GatewayError && error.status === 404) return null;
      throw error;
    }
  }

  async transition(
    id: string,
    to: "SENT" | "PAID" | "FAILED" | "CANCELLED",
    failureReason?: string,
  ): Promise<TransferRecord> {
    const body = await this.call<{ status?: string; id?: string }>(
      `/api/v1/simulation/transfers/${encodeURIComponent(id)}/transition`,
      {
        method: "POST",
        body: { status: to, ...(failureReason ? { failure_type: failureReason } : {}) },
      },
    );
    const existing = await this.getTransfer(id);
    return {
      ...(existing ?? {
        id,
        requestId: "",
        currency: "USD",
        amount: 0,
        fee: 0,
        beneficiaryId: "",
        createdAt: new Date().toISOString(),
      }),
      status: mapStatus(body.status ?? to),
    };
  }

  async deposit(input: DepositInput): Promise<{ depositId: string; note: string }> {
    const body = await this.call<{ id?: string; status?: string }>(
      "/api/v1/simulation/deposit/create",
      {
        method: "POST",
        onBehalfOf: input.onBehalfOf,
        body: {
          global_account_id: input.globalAccountId,
          amount: input.amount,
          currency: input.currency,
          payer_name: input.payerName,
        },
      },
    );
    return {
      depositId: body.id ?? `dep_${Date.now()}`,
      // Guide: balance is available immediately even when the response is PENDING.
      note: `simulated deposit status ${body.status ?? "PENDING"}`,
    };
  }
}

function mapStatus(status?: string): TransferRecord["status"] {
  switch ((status ?? "").toUpperCase()) {
    case "PAID":
    case "SETTLED":
      return "PAID";
    case "SENT":
    case "PROCESSING":
      return "PROCESSING";
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "PROCESSING";
  }
}
