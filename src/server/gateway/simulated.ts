import type { Currency, QuoteRecord, TransferRecord } from "../types";
import { platformWallet, rate, store } from "../state/store";
import {
  GatewayError,
  type DepositInput,
  type GatewayContext,
  type MoneyGateway,
  type QuoteInput,
  type TransferInput,
} from "./types";

/**
 * A local re-implementation of the Airwallex sandbox contract.
 *
 * This is not a mock that always says yes. It reproduces the behaviours the
 * Airwallex builder guide documents, including the ones that are traps, because
 * a guardrail tested against a polite fake proves nothing. Each deviation from
 * what a reasonable engineer would expect is commented with the behaviour it
 * models.
 */
export class SimulatedGateway implements MoneyGateway {
  readonly mode = "sim" as const;

  async describe(): Promise<string> {
    return "Ledgerline simulation (documented sandbox behaviour, no network)";
  }

  async listBalances(ctx?: GatewayContext): Promise<Record<Currency, number>> {
    const state = store.get();
    const target = ctx?.onBehalfOf
      ? state.wallets.find((w) => w.id === ctx.onBehalfOf)
      : undefined;
    return { ...(target ?? platformWallet(state)).balances };
  }

  async fxRate(sell: Currency, buy: Currency): Promise<number> {
    return rate(sell, buy);
  }

  async quote(input: QuoteInput): Promise<QuoteRecord> {
    const r = rate(input.sellCurrency, input.buyCurrency);
    // Registration is the caller's job, not the gateway's, so that the engine
    // tracks quotes identically whether they came from the simulation or from
    // the live sandbox.
    return {
      id: `qte_${Math.random().toString(36).slice(2, 10)}`,
      from: input.sellCurrency,
      to: input.buyCurrency,
      sell: input.sellAmount,
      buy: round2(input.sellAmount * r),
      rate: r,
      usedBy: [],
    };
  }

  async convert(
    quoteId: string,
    requestId: string,
    ctx?: GatewayContext,
  ): Promise<{ conversionId: string; note: string }> {
    const state = store.get();
    const quote = state.quotes.find((q) => q.id === quoteId);
    if (!quote) throw new GatewayError("quote not found", 404, "not_found");

    if (quote.usedBy.includes(requestId)) {
      // Real idempotency: the same key returns the original conversion.
      return { conversionId: `cnv_${quoteId}_${requestId}`, note: "replayed, idempotent" };
    }

    // DOCUMENTED TRAP. Airwallex accepts the same quote_id again as long as the
    // request_id is new, so a client that assumes single use and a client that
    // assumes replayable both get a 200. The simulation accepts it too. Only
    // the engine refuses.
    const wallet = ctx?.onBehalfOf
      ? state.wallets.find((w) => w.id === ctx.onBehalfOf)
      : undefined;

    // DOCUMENTED TRAP. Without x-on-behalf-of the conversion is booked against
    // the platform wallet and still returns 201. Nothing in the response says
    // it was the wrong wallet.
    const target = wallet ?? platformWallet(state);

    const balances = target.balances;
    balances[quote.from] = round2((balances[quote.from] ?? 0) - quote.sell);
    balances[quote.to] = round2((balances[quote.to] ?? 0) + quote.buy);
    quote.usedBy.push(requestId);

    return {
      conversionId: `cnv_${Math.random().toString(36).slice(2, 10)}`,
      note: wallet
        ? `booked on ${target.id}`
        : `booked on ${target.id}. No x-on-behalf-of was sent, which is correct only if this wallet owns the funds`,
    };
  }

  async pay(input: TransferInput): Promise<TransferRecord> {
    const state = store.get();
    const existing = state.transfers.find((t) => t.requestId === input.requestId);
    if (existing) {
      // Same request_id is genuinely idempotent server side.
      return existing;
    }

    const fee = input.transferMethod === "SWIFT" ? store.policy.swiftFee.amount : 0;
    // Same trap as convert: with no on-behalf-of this books against the
    // platform wallet, and nothing in the response tells the caller that is not
    // what they asked for.
    const wallet = input.onBehalfOf
      ? state.wallets.find((w) => w.id === input.onBehalfOf) ?? platformWallet(state)
      : platformWallet(state);
    const owed = round2(input.amount + (input.currency === "EUR" ? fee : 0));

    if ((wallet.balances[input.currency] ?? 0) < owed) {
      throw new GatewayError(
        `insufficient funds for ${input.currency} ${owed}`,
        422,
        "insufficient_funds",
      );
    }

    wallet.balances[input.currency] = round2((wallet.balances[input.currency] ?? 0) - owed);

    const record: TransferRecord = {
      id: `trf_${Math.random().toString(36).slice(2, 10)}`,
      requestId: input.requestId,
      obligationId: input.obligationId,
      currency: input.currency,
      amount: input.amount,
      fee,
      beneficiaryId: input.beneficiaryId,
      status: "PROCESSING",
      createdAt: new Date().toISOString(),
      supersedes: input.supersedes,
    };
    state.transfers.push(record);
    return record;
  }

  async getTransfer(id: string): Promise<TransferRecord | null> {
    return store.get().transfers.find((t) => t.id === id) ?? null;
  }

  async transition(
    id: string,
    to: "SENT" | "PAID" | "FAILED" | "CANCELLED",
    failureReason?: string,
  ): Promise<TransferRecord> {
    const state = store.get();
    const transfer = state.transfers.find((t) => t.id === id);
    if (!transfer) throw new GatewayError("transfer not found", 404, "not_found");

    // DOCUMENTED TRAP. A transfer must reach SENT before PAID, and FAILED with
    // a failure_type also requires SENT first. A client that jumps straight to
    // the terminal state gets an error it will usually retry, then blame the
    // API.
    const allowed: Record<string, string[]> = {
      PROCESSING: ["SENT", "CANCELLED"],
      SENT: ["PAID", "FAILED"],
      PAID: [],
      FAILED: [],
      CANCELLED: [],
    };

    if (!allowed[transfer.status]?.includes(to)) {
      throw new GatewayError(
        `cannot move ${transfer.status} to ${to}. SENT must precede ${to}`,
        400,
        "invalid_state_transition",
      );
    }
    if (to === "FAILED" && !failureReason) {
      throw new GatewayError(
        "FAILED requires a failure_type. A bare cancel only yields a simulation reason",
        400,
        "missing_failure_type",
      );
    }

    transfer.status = to;
    if (failureReason) transfer.failureReason = failureReason;
    return transfer;
  }

  async deposit(input: DepositInput): Promise<{ depositId: string; note: string }> {
    const state = store.get();
    const target = input.onBehalfOf
      ? state.wallets.find((w) => w.id === input.onBehalfOf) ?? platformWallet(state)
      : platformWallet(state);
    target.balances[input.currency] = round2((target.balances[input.currency] ?? 0) + input.amount);
    return {
      depositId: `dep_${Math.random().toString(36).slice(2, 10)}`,
      note: `available immediately on ${target.id} even though the response reads PENDING`,
    };
  }
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
