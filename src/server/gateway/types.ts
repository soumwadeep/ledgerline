import type { Currency, QuoteRecord, TransferRecord } from "../types";

/**
 * The only surface the policy engine is allowed to reach money through.
 *
 * Two implementations exist and they are interchangeable:
 *   SimulatedGateway  reproduces documented sandbox behaviour locally, traps included
 *   AirwallexGateway  calls the real sandbox REST API
 *
 * The engine never inspects which one it has. That is the point: the guardrail
 * is written against the documented contract of the API, not against a happy
 * path, so the same checks that pass in tests are the ones that run live.
 */
export interface GatewayContext {
  /** Sent as x-on-behalf-of. Omitting it makes Airwallex act on the platform wallet. */
  onBehalfOf?: string;
}

export interface DepositInput {
  globalAccountId: string;
  amount: number;
  currency: Currency;
  payerName: string;
  onBehalfOf?: string;
}

export interface QuoteInput {
  sellCurrency: Currency;
  sellAmount: number;
  buyCurrency: Currency;
}

export interface TransferInput {
  requestId: string;
  currency: Currency;
  amount: number;
  beneficiaryId: string;
  transferMethod: "LOCAL" | "SWIFT";
  note: string;
  obligationId?: string;
  supersedes?: string;
  onBehalfOf?: string;
}

export interface MoneyGateway {
  readonly mode: "sim" | "airwallex";
  /** Human readable identity of the account in use, for the UI header. */
  describe(): Promise<string>;
  listBalances(ctx?: GatewayContext): Promise<Record<Currency, number>>;
  fxRate(sell: Currency, buy: Currency): Promise<number>;
  quote(input: QuoteInput): Promise<QuoteRecord>;
  /** Returns the conversion id. `requestId` is the idempotency key. */
  convert(quoteId: string, requestId: string, ctx?: GatewayContext): Promise<{ conversionId: string; note: string }>;
  pay(input: TransferInput): Promise<TransferRecord>;
  getTransfer(id: string): Promise<TransferRecord | null>;
  transition(id: string, to: "SENT" | "PAID" | "FAILED" | "CANCELLED", failureReason?: string): Promise<TransferRecord>;
  deposit(input: DepositInput): Promise<{ depositId: string; note: string }>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}
