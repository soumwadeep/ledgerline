import type {
  Decision,
  Intent,
  Obligation,
  PolicyConfig,
  SimulationResult,
  WorldState,
} from "../types";
import { platformWallet, store } from "../state/store";
import { round2 } from "../gateway/simulated";
import type { MoneyGateway } from "../gateway/types";
import { DecisionLedger } from "./ledger";
import { decide, estimateCost, reversibilityOf, runChecks } from "./policy";

/**
 * The engine is the only component in the system that can cause money to move.
 *
 * Its contract is deliberately narrow: an intent goes in, a decision comes out,
 * and money only leaves through `execute` for a decision that is either
 * auto_execute or has been explicitly approved by a person. There is no path
 * from the agent to the gateway that does not pass through here.
 */
export class LedgerlineEngine {
  readonly ledger = new DecisionLedger();

  constructor(readonly gateway: MoneyGateway) {}

  get policy(): PolicyConfig {
    return store.policy;
  }

  /**
   * Dry run. Projects the balance effect without touching the gateway, so a
   * judge can see what an intent would have done before it is allowed to.
   */
  private simulate(intent: Intent, state: WorldState): SimulationResult {
    const obligation = state.obligations.find((o) => o.id === intent.obligationId);
    const wallet =
      (intent.onBehalfOf ?? obligation?.fundedBy
        ? state.wallets.find((w) => w.id === (intent.onBehalfOf ?? obligation?.fundedBy))
        : undefined) ?? platformWallet(state);
    const after: Record<string, number> = { ...wallet.balances };
    const fee = intent.currency === "EUR" ? this.policy.swiftFee.amount : 0;

    switch (intent.kind) {
      case "fund":
      case "replace_transfer":
        after[intent.currency] = round2((after[intent.currency] ?? 0) - intent.amount - fee);
        return {
          ok: (after[intent.currency] ?? 0) >= (this.policy.reserveFloors[intent.currency] ?? 0),
          balancesAfter: after,
          note: `payout of ${intent.amount} ${intent.currency}${fee ? ` plus ${fee} fee` : ""}`,
        };
      case "convert": {
        const quote = state.quotes.find((q) => q.id === intent.quoteId);
        const buy = quote ? quote.buy : round2(intent.amount * 1);
        after[intent.currency] = round2((after[intent.currency] ?? 0) - intent.amount);
        if (intent.to) after[intent.to] = round2((after[intent.to] ?? 0) + buy);
        return { ok: true, balancesAfter: after, note: `sells ${intent.amount} ${intent.currency} for ${buy} ${intent.to}` };
      }
      default:
        return { ok: true, balancesAfter: after, note: "no balance effect" };
    }
  }

  evaluate(intent: Intent): Decision {
    const state = store.get();
    const obligation = state.obligations.find((o) => o.id === intent.obligationId);
    const checks = runChecks({ intent, state, policy: this.policy, obligation });
    const verdict = decide(checks, intent, this.policy);
    const cost = estimateCost({ intent, state, policy: this.policy, obligation });
    const simulation = this.simulate(intent, state);

    const failed = checks.filter((c) => !c.passed && c.severity !== "warn");
    const rationale = failed.length
      ? failed.map((c) => `${c.code}: ${c.detail}`).join(" | ")
      : `All ${checks.length} checks passed. ${cost.summary}`;

    const decision: Decision = {
      intentId: intent.id,
      verdict,
      checks,
      reversibility: reversibilityOf(intent),
      cost,
      simulation,
      rationale,
      decidedAt: new Date().toISOString(),
    };

    state.decisions[intent.id] = decision;
    this.ledger.append("decision", {
      intentId: intent.id,
      kind: intent.kind,
      amount: intent.amount,
      currency: intent.currency,
      requestId: intent.requestId,
      verdict,
      reversibility: decision.reversibility,
      failed: failed.map((c) => c.code),
      passed: checks.filter((c) => c.passed).map((c) => c.code),
      agentReason: intent.reason,
      agentConfidence: intent.confidence,
    });

    if (verdict === "blocked") {
      this.ledger.append("block", {
        intentId: intent.id,
        blockedBy: failed.filter((c) => c.severity === "block").map((c) => c.code),
        note: "no request was ever sent to the gateway",
      });
    }

    return decision;
  }

  /**
   * Runs an evaluated decision. Blocked intents cannot reach this method
   * through the public API, and the guard inside is not decoration: it is what
   * makes the invariant testable rather than conventional.
   */
  async execute(intent: Intent, approvedBy?: string): Promise<{ ok: boolean; detail: string; decision: Decision }> {
    const state = store.get();
    const existing = state.decisions[intent.id] ?? this.evaluate(intent);

    if (existing.verdict === "blocked") {
      return { ok: false, detail: "refused: verdict is blocked", decision: existing };
    }
    if (existing.verdict === "escalate" && !approvedBy) {
      return { ok: false, detail: "refused: awaiting human approval", decision: existing };
    }
    if (approvedBy) {
      existing.approvedBy = approvedBy;
      this.ledger.append("approval", { intentId: intent.id, approvedBy, reversibility: existing.reversibility });
    }

    const obligation = state.obligations.find((o) => o.id === intent.obligationId);

    try {
      switch (intent.kind) {
        case "fund":
        case "replace_transfer": {
          if (!obligation) throw new Error("intent references an unknown obligation");

          const transfer = await this.gateway.pay({
            requestId: intent.requestId,
            currency: intent.currency,
            amount: intent.amount,
            beneficiaryId: obligation.beneficiaryId,
            transferMethod: obligation.transferMethod,
            note: `${intent.kind} ${obligation.payee}`,
            obligationId: obligation.id,
            supersedes: intent.replacesTransferId,
            onBehalfOf: intent.onBehalfOf,
          });

          if (intent.kind === "replace_transfer" && intent.replacesTransferId) {
            const superseded = state.transfers.find((t) => t.id === intent.replacesTransferId);
            if (superseded) superseded.status = "CANCELLED";
          }

          markSettled(obligation, transfer.id);
          state.settlementKeys[intent.obligationId ?? ""] = [
            ...(state.settlementKeys[intent.obligationId ?? ""] ?? []),
            intent.requestId,
          ];

          this.ledger.append("execution", {
            intentId: intent.id,
            transferId: transfer.id,
            status: transfer.status,
            amount: transfer.amount,
            currency: transfer.currency,
            fee: transfer.fee,
            obligationId: obligation.id,
            approvedBy,
          });
          return { ok: true, detail: `transfer ${transfer.id} created in ${transfer.status}`, decision: existing };
        }

        case "convert": {
          const { conversionId, note } = await this.gateway.convert(
            intent.quoteId as string,
            intent.requestId,
            intent.onBehalfOf ? { onBehalfOf: intent.onBehalfOf } : undefined,
          );
          const quote = state.quotes.find((q) => q.id === intent.quoteId);
          if (quote) {
            state.consumedQuotes[quote.id] = [...(state.consumedQuotes[quote.id] ?? []), intent.requestId];
          }
          this.ledger.append("execution", {
            intentId: intent.id,
            conversionId,
            quoteId: intent.quoteId,
            note,
            approvedBy,
          });
          return { ok: true, detail: `converted. ${note}`, decision: existing };
        }

        case "defer": {
          if (!obligation) throw new Error("intent references an unknown obligation");
          obligation.deferredDays += intent.amount;
          obligation.dueInDays += intent.amount;
          obligation.status = "deferred";
          this.ledger.append("execution", {
            intentId: intent.id,
            deferredDays: intent.amount,
            newDueInDays: obligation.dueInDays,
            penaltyAccrued: existing.cost.penalty,
            approvedBy,
          });
          return { ok: true, detail: `deferred ${intent.amount} day(s)`, decision: existing };
        }

        case "escalate": {
          if (obligation) obligation.status = "escalated";
          this.ledger.append("execution", { intentId: intent.id, escalated: obligation?.payee ?? null });
          return { ok: true, detail: "escalated to a person", decision: existing };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ledger.append("block", { intentId: intent.id, gatewayRefused: true, message });
      return { ok: false, detail: `gateway refused: ${message}`, decision: existing };
    }

    return { ok: false, detail: "unhandled intent kind", decision: existing };
  }

  /**
   * Evaluate a batch, execute what is allowed, and leave the rest queued.
   *
   * Order matters and is not the agent's: statutory and non-deferrable items are
   * funded first, because a decision taken later cannot unspend what an earlier
   * one already committed.
   */
  async runCycle(intents: Intent[]): Promise<{ intent: Intent; decision: Decision; outcome?: string }[]> {
    const ordered = [...intents].sort((a, b) => executionPriority(a) - executionPriority(b));
    const results: { intent: Intent; decision: Decision; outcome?: string }[] = [];

    for (const intent of ordered) {
      const decision = this.evaluate(intent);
      if (decision.verdict === "auto_execute") {
        const ran = await this.execute(intent);
        results.push({ intent, decision: ran.decision, outcome: ran.ok ? `executed. ${ran.detail}` : ran.detail });
      } else {
        results.push({ intent, decision, outcome: decision.verdict === "blocked" ? "blocked before any call was made" : "queued for approval" });
      }
    }
    return results;
  }

  async approve(intentId: string, by: string) {
    const state = store.get();
    const intent = state.pendingIntents.find((i) => i.id === intentId);
    if (!intent) return { ok: false, detail: "intent is no longer pending" };
    const result = await this.execute(intent, by);
    if (result.ok) {
      state.pendingIntents = state.pendingIntents.filter((i) => i.id !== intentId);
    }
    return result;
  }

  async reject(intentId: string, by: string) {
    const state = store.get();
    const intent = state.pendingIntents.find((i) => i.id === intentId);
    if (!intent) return { ok: false, detail: "intent is no longer pending" };
    state.pendingIntents = state.pendingIntents.filter((i) => i.id !== intentId);
    const obligation = state.obligations.find((o) => o.id === intent.obligationId);
    if (obligation && obligation.status === "unsettled") obligation.status = "escalated";
    this.ledger.append("block", { intentId, rejectedBy: by, note: "human declined the intent" });
    return { ok: true, detail: "declined. Nothing was sent to the gateway" };
  }
}

const CRITICALITY_ORDER: Record<Obligation["criticality"], number> = {
  payroll: 0,
  tax: 1,
  lender: 2,
  supplier: 3,
  saas: 4,
};

function executionPriority(intent: Intent): number {
  const state = store.get();
  const obligation = state.obligations.find((o) => o.id === intent.obligationId);
  const kindRank = intent.kind === "convert" ? -1 : intent.kind === "defer" || intent.kind === "escalate" ? 2 : 0;
  const criticality = obligation ? CRITICALITY_ORDER[obligation.criticality] : 5;
  return kindRank * 10 + criticality;
}

function markSettled(obligation: Obligation, transferId: string): void {
  obligation.status = "paid";
  obligation.settledByTransferId = transferId;
}
