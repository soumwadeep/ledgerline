import type {
  CostEstimate,
  Intent,
  Obligation,
  PolicyCheck,
  PolicyConfig,
  Reversibility,
  Wallet,
  WorldState,
} from "../types";
import { platformWallet } from "../state/store";
import { round2 } from "../gateway/simulated";

/**
 * Every check here is a pure function of the world state and one proposed
 * intent. None of them call the network, and none of them read the agent's
 * prose. The agent can say anything it likes in `reason`; the verdict is
 * computed from numbers.
 *
 * The checks named TRAP in their comment correspond one to one with behaviours
 * documented in the Airwallex builder guide. They are the reason this layer
 * exists.
 */

export const REVERSIBILITY: Record<Intent["kind"], Reversibility> = {
  fund: "irreversible",
  replace_transfer: "irreversible",
  convert: "costly",
  defer: "reversible",
  escalate: "reversible",
};

const RANK: Record<Reversibility, number> = {
  reversible: 0,
  costly: 1,
  irreversible: 2,
};

export function reversibilityOf(intent: Intent): Reversibility {
  return REVERSIBILITY[intent.kind];
}

interface CheckInput {
  intent: Intent;
  state: WorldState;
  policy: PolicyConfig;
  obligation?: Obligation;
}

function check(code: string, label: string, passed: boolean, severity: PolicyCheck["severity"], detail: string): PolicyCheck {
  return { code, label, passed, severity: passed ? "pass" : severity, detail };
}

function walletFor(state: WorldState, onBehalfOf?: string): Wallet {
  return (onBehalfOf ? state.wallets.find((w) => w.id === onBehalfOf) : undefined) ?? platformWallet(state);
}

export function runChecks({ intent, state, policy, obligation }: CheckInput): PolicyCheck[] {
  const checks: PolicyCheck[] = [];
  // The wallet that would actually be debited. Reading the platform balance for
  // a connected account action is how a guardrail approves a payment it should
  // have refused.
  const wallet = walletFor(state, intent.onBehalfOf ?? obligation?.fundedBy);

  // Scale. Airwallex takes major units. An agent that has been reading Stripe
  // documentation all morning will send 3100000 for thirty one thousand dollars.
  checks.push(
    check(
      "AMOUNT_SCALE",
      "Amount is in major units and non zero",
      intent.amount > 0 && intent.amount <= policy.maxSinglePayout * 20,
      "block",
      `intent amount ${intent.amount} ${intent.currency}. Airwallex amounts are major units, so 31000 is thirty one thousand dollars, not cents`,
    ),
  );

  if (intent.kind === "fund" || intent.kind === "replace_transfer") {
    const beneficiaryId = obligation?.beneficiaryId ?? "";

    checks.push(
      check(
        "APPROVED_PAYEE",
        "Payee is on the allowlist",
        policy.approvedBeneficiaries.includes(beneficiaryId),
        "block",
        `${beneficiaryId || "no beneficiary"} is not an approved payee. An agent cannot invent a destination account`,
      ),
    );

    checks.push(
      // TRAP. A replacement payout uses a new request_id, which is correct,
      // but a new request_id for an obligation that already settled is a
      // second payment of the same invoice.
      check(
        "DUPLICATE_OBLIGATION",
        "Obligation has not already been settled",
        !obligation || obligation.status !== "paid",
        "block",
        obligation
          ? `obligation ${obligation.id} is already ${obligation.status}. Paying it again returns 200 and moves money twice`
          : "no obligation attached",
      ),
    );

    const fee = intent.currency === "EUR" ? policy.swiftFee.amount : 0;
    const projected = round2((wallet.balances[intent.currency] ?? 0) - intent.amount - fee);
    const floor = policy.reserveFloors[intent.currency] ?? 0;

    checks.push(
      check(
        "RESERVE_FLOOR",
        "Reserve floor survives",
        projected >= floor,
        "block",
        `${intent.currency} would land at ${projected} against a floor of ${floor}. Deficit ${round2(floor - projected)}`,
      ),
    );

    checks.push(
      check(
        "SINGLE_PAYOUT_CAP",
        "Within the single payout cap",
        intent.amount <= policy.maxSinglePayout,
        "escalate",
        `${intent.amount} exceeds the auto execute cap of ${policy.maxSinglePayout}. A person approves this one`,
      ),
    );

    checks.push(
      check(
        "CONFIDENCE_FLOOR",
        "Agent confidence is adequate for an irreversible action",
        intent.confidence >= 0.6,
        "escalate",
        `agent reported confidence ${intent.confidence.toFixed(2)}. Low confidence on an irreversible action goes to a human rather than being argued with`,
      ),
    );
  }

  if (intent.kind === "convert") {
    const quote = state.quotes.find((q) => q.id === intent.quoteId) ?? null;
    const sells = intent.currency;
    const sourceWallet = walletFor(state, intent.onBehalfOf);
    const available = sourceWallet.balances[sells] ?? 0;
    const floor = policy.reserveFloors[sells] ?? 0;

    checks.push(
      check(
        "CONVERT_SOURCE",
        "Source currency has enough to sell",
        available - intent.amount >= floor,
        "block",
        `selling ${intent.amount} ${sells} from ${available} leaves ${round2(available - intent.amount)} against a floor of ${floor}`,
      ),
    );

    checks.push(
      check(
        "CONVERT_TARGET",
        "Target currency is one the desk actually holds",
        Object.keys(wallet.balances).includes(intent.to ?? "") ||
          Object.keys(policy.reserveFloors).includes(intent.to ?? ""),
        "warn",
        `no existing ${intent.to} balance. The conversion will create one`,
      ),
    );

    checks.push(
      check(
        "QUOTE_BOUND",
        "Conversion is bound to a quote the engine issued",
        Boolean(intent.quoteId) && Boolean(quote),
        "block",
        intent.quoteId
          ? `quote ${intent.quoteId} is not in the engine's quote registry. A conversion cannot run against a quote this engine did not price`
          : "no quote id on the intent. Converting at an unquoted rate is how an agent discovers the spread after the fact",
      ),
    );

    if (quote) {
      checks.push(
        // TRAP. Airwallex accepts the same quote_id again provided the
        // request_id is new. A client written on the assumption that quotes
        // are single use will happily convert twice at a stale rate.
        check(
          "QUOTE_REPLAY",
          "Quote has not already been converted",
          quote.usedBy.length === 0,
          "block",
          `quote ${quote.id} has already been converted ${quote.usedBy.length} time(s). The API accepts a replay with a fresh request_id and returns 201 both times`,
        ),
      );
    }
  }

  if (intent.kind === "defer" && obligation) {
    const days = intent.amount;
    checks.push(
      check(
        "DEFER_BREACH",
        "Deferral stays inside the contractual window",
        obligation.deferredDays + days <= obligation.maxDeferrableDays,
        "block",
        `${obligation.payee} may slip ${obligation.maxDeferrableDays} day(s). It has already slipped ${obligation.deferredDays}. Deferring ${days} more is a breach, not a choice`,
      ),
    );
    checks.push(
      check(
        "DEFER_STATUTORY",
        "Not a statutory or payroll obligation",
        obligation.maxDeferrableDays > 0,
        "block",
        `${obligation.criticality} cannot be deferred at all. There is no policy under which an agent chooses this`,
      ),
    );
  }

  // TRAP. The connected account one. If an intent is meant to act on a
  // subsidiary wallet but carries no on-behalf-of, Airwallex books it against
  // the platform wallet and returns success.
  if (obligation?.fundedBy) {
    checks.push(
      check(
        "ON_BEHALF_OF",
        "Scoped to the owning account",
        intent.onBehalfOf === obligation.fundedBy,
        "block",
        `${obligation.id} is funded by ${obligation.fundedBy} but the call carries no x-on-behalf-of. Airwallex would move the platform wallet's money and return 201`,
      ),
    );
  }

  if (intent.kind === "replace_transfer" && intent.replacesTransferId) {
    const original = state.transfers.find((t) => t.id === intent.replacesTransferId);
    const priorKeys = state.transfers.filter((t) => t.obligationId === intent.obligationId).map((t) => t.requestId);

    checks.push(
      // TRAP. Replacing a transfer that is merely slow, rather than failed,
      // produces two live payments for one invoice.
      check(
        "REPLACEMENT_IS_TERMINAL",
        "Transfer being replaced is in a terminal state",
        !!original && (original.status === "FAILED" || original.status === "CANCELLED"),
        "block",
        original
          ? `the transfer being replaced is ${original.status}, not terminal. Anything still in flight must be waited on, not duplicated`
          : "the transfer being replaced does not exist",
      ),
    );

    checks.push(
      check(
        "REPLACEMENT_KEY_FRESH",
        "Replacement uses a request id that has not settled this obligation",
        !priorKeys.includes(intent.requestId),
        "block",
        `reusing request_id ${intent.requestId} would replay the original transfer. Airwallex returns the same object, so the agent believes a second payment went out when none did`,
      ),
    );
  }

  return checks;
}

export function estimateCost({ intent, state, policy, obligation }: CheckInput): CostEstimate {
  const fee =
    intent.kind === "fund" || intent.kind === "replace_transfer"
      ? intent.currency === "EUR"
        ? policy.swiftFee.amount
        : 0
      : 0;

  let penalty = 0;
  if (intent.kind === "defer" && obligation) {
    penalty = round2(obligation.latePenaltyPerDay * intent.amount);
  }

  let summary: string;
  if (intent.kind === "replace_transfer") {
    summary = `second ${intent.currency} payout. ${fee > 0 ? `Adds a ${fee} ${policy.swiftFee.currency} SWIFT fee, so closing this incident costs the fee twice` : "no additional rail fee"}`;
  } else if (intent.kind === "defer") {
    summary = `no money moves now. Accrues ${penalty} in late penalty over ${intent.amount} day(s)`;
  } else if (intent.kind === "convert") {
    summary = `sells ${intent.amount} ${intent.currency} for ${intent.to}. Spread is the cost and it is not refundable`;
  } else if (intent.kind === "fund") {
    summary = `moves ${intent.amount} ${intent.currency} out${fee ? ` plus ${fee} fee` : ""}. Irreversible once SENT`;
  } else {
    summary = "no money movement. Hands the decision to a person";
  }

  return { fee, feeCurrency: policy.swiftFee.currency, penalty, summary };
}

/**
 * Verdict. Blocks always win. Then anything the check layer flagged as needing a
 * person. Then the reversibility ceiling.
 */
export function decide(
  checks: PolicyCheck[],
  intent: Intent,
  policy: PolicyConfig,
): "auto_execute" | "escalate" | "blocked" {
  if (checks.some((c) => !c.passed && c.severity === "block")) return "blocked";
  if (checks.some((c) => !c.passed && c.severity === "escalate")) return "escalate";

  const rev = RANK[reversibilityOf(intent)];
  const ceiling = RANK[policy.humanApprovalAt];
  if (rev > ceiling) return "escalate";

  // Irreversible and inside the cap is the pre-authorised case: an approved
  // payee, a known amount, reserve floor intact. Making a human click through
  // that is how approval queues become rubber stamps.
  if (rev === RANK.irreversible && intent.amount > policy.maxSinglePayout) return "escalate";

  return "auto_execute";
}
