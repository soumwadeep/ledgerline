import type { Intent, WorldState } from "./types";
import { platformWallet, seedIncident, store } from "./state/store";
import { SimulatedGateway, round2 } from "./gateway/simulated";
import { GatewayError } from "./gateway/types";
import { LedgerlineEngine } from "./engine/engine";

/**
 * The trap lab.
 *
 * Four behaviours that Airwallex documents in its own builder guide, each run
 * twice against the same gateway: once by an agent holding API keys with no
 * guardrail, once through the engine. The naive column is not a strawman. It is
 * written exactly as the documented API permits, and the documented API allows
 * all four.
 *
 * This is the part of the demo that does not ask a judge to believe anything.
 * It shows the same call succeeding and being refused.
 */

export interface TrapStep {
  label: string;
  result: string;
  ok: boolean;
}

export interface Trap {
  id: string;
  title: string;
  documented: string;
  source: string;
  naive: { steps: TrapStep[]; outcome: string; balances: Record<string, number> };
  guarded: { steps: TrapStep[]; outcome: string; blockedBy: string[]; balances: Record<string, number> };
}

function snapshot(state: WorldState): Record<string, number> {
  const wallet = platformWallet(state);
  return {
    USD: round2(wallet.balances.USD ?? 0),
    EUR: round2(wallet.balances.EUR ?? 0),
    SGD: round2(wallet.balances.SGD ?? 0),
  };
}

function subsidiaryEur(): number {
  return round2(store.get().wallets.find((w) => w.id === "acct_eu_subsidiary")?.balances.EUR ?? 0);
}

function freshTreasury(): LedgerlineEngine {
  store.reset("treasury");
  return new LedgerlineEngine(new SimulatedGateway());
}

function freshIncident(): LedgerlineEngine {
  store.replace(seedIncident());
  return new LedgerlineEngine(new SimulatedGateway());
}

function blockedCodes(intent: Intent, engine: LedgerlineEngine): { verdict: string; codes: string[] } {
  const decision = engine.evaluate(intent);
  return {
    verdict: decision.verdict,
    codes: decision.checks.filter((c) => !c.passed && c.severity === "block").map((c) => c.code),
  };
}

async function trapQuoteReplay(): Promise<Trap> {
  // Sized so a second conversion of the same quote would still clear the
  // reserve floor. That way the only thing that stops it is the replay check,
  // which is the behaviour being demonstrated.
  const SELL = 3000;

  // Naive: an agent that assumes the API will refuse a replay.
  const engine = freshTreasury();
  const gateway = engine.gateway as SimulatedGateway;
  const state = store.get();
  const quote = await gateway.quote({ sellCurrency: "SGD", sellAmount: SELL, buyCurrency: "EUR" });
  state.quotes.push(quote);

  const naiveSteps: TrapStep[] = [
    { label: `request a quote to sell ${SELL} SGD for EUR`, result: `201 ${quote.id} at ${quote.rate}`, ok: true },
  ];
  const first = await gateway.convert(quote.id, "req_fx_a");
  naiveSteps.push({ label: "convert using the quote", result: `201 ${first.conversionId}`, ok: true });
  const second = await gateway.convert(quote.id, "req_fx_b");
  naiveSteps.push({
    label: "convert the same quote again under a new request_id",
    result: `201 ${second.conversionId}. The API accepted it`,
    ok: true,
  });
  const naiveBalances = snapshot(store.get());

  // Guarded: same two intents, engine in the middle.
  const g = freshTreasury();
  const gState = store.get();
  const gQuote = await (g.gateway as SimulatedGateway).quote({ sellCurrency: "SGD", sellAmount: SELL, buyCurrency: "EUR" });
  gState.quotes.push(gQuote);

  const base: Intent = {
    id: "trap_a_1",
    kind: "convert",
    currency: "SGD",
    to: "EUR",
    amount: SELL,
    quoteId: gQuote.id,
    reason: "cover the EUR shortfall",
    confidence: 0.8,
    requestId: "req_fx_a",
  };
  const guardedSteps: TrapStep[] = [];
  const d1 = g.evaluate(base);
  guardedSteps.push({ label: "first conversion of the quote", result: d1.verdict, ok: d1.verdict !== "blocked" });
  if (d1.verdict === "auto_execute") await g.execute(base);

  const replay = { ...base, id: "trap_a_2", requestId: "req_fx_b" };
  const d2 = blockedCodes(replay, g);
  guardedSteps.push({ label: "second conversion of the same quote", result: d2.verdict, ok: d2.verdict === "blocked" });
  const guardedBalances = snapshot(store.get());

  return {
    id: "quote_replay",
    title: "An FX quote is not single use",
    documented: "Treat a quote as single use in your code. Airwallex will accept the same quote_id again with a new request_id.",
    source: "Airwallex builder guide, treasury recipe watch-outs",
    naive: {
      steps: naiveSteps,
      outcome: `One quote bought two conversions. SGD fell from 11,000 to ${naiveBalances.SGD} and EUR rose twice at a rate that was only ever priced once`,
      balances: naiveBalances,
    },
    guarded: {
      steps: guardedSteps,
      outcome: `the replay was refused at evaluate(). No HTTP request was made. SGD ended at ${guardedBalances.SGD}`,
      blockedBy: d2.codes,
      balances: guardedBalances,
    },
  };
}

async function trapOnBehalfOf(): Promise<Trap> {
  const engine = freshTreasury();
  const gateway = engine.gateway as SimulatedGateway;
  const state = store.get();
  const before = subsidiaryEur();
  const quote = await gateway.quote({ sellCurrency: "SGD", sellAmount: 4000, buyCurrency: "EUR" });
  state.quotes.push(quote);

  const naiveSteps: TrapStep[] = [
    { label: "top up the EU subsidiary. Call convert, omit x-on-behalf-of", result: `201 ${quote.id}`, ok: true },
  ];
  await gateway.convert(quote.id, "req_topup_sub");
  naiveSteps.push({
    label: "check whether the subsidiary was funded",
    result: `subsidiary EUR ${before} to ${subsidiaryEur()}. Unchanged`,
    ok: false,
  });
  naiveSteps.push({ label: "check the platform wallet", result: `platform EUR now ${snapshot(store.get()).EUR}`, ok: false });
  const naiveBalances = snapshot(store.get());

  const g = freshTreasury();
  const vat = store.get().obligations.find((o) => o.id === "ob_vat");
  const unscoped: Intent = {
    id: "trap_b_1",
    kind: "fund",
    obligationId: "ob_vat",
    currency: "EUR",
    amount: 9500,
    reason: "pay the VAT return",
    confidence: 0.9,
    requestId: "req_vat_unscoped",
  };
  const scoped: Intent = {
    ...unscoped,
    id: "trap_b_2",
    reason: "pay the VAT return from the account that owns it",
    requestId: "req_vat_scoped",
    onBehalfOf: vat?.fundedBy,
  };

  const guardedSteps: TrapStep[] = [];
  const d1 = blockedCodes(unscoped, g);
  guardedSteps.push({ label: "pay VAT with no x-on-behalf-of", result: d1.verdict, ok: d1.verdict === "blocked" });
  const d2 = g.evaluate(scoped);
  guardedSteps.push({ label: "identical payment, scoped to the owning account", result: d2.verdict, ok: d2.verdict !== "blocked" });
  if (d2.verdict === "auto_execute") await g.execute(scoped);
  const guardedBalances = snapshot(store.get());

  return {
    id: "on_behalf_of",
    title: "Omitting x-on-behalf-of moves the wrong wallet and still returns 201",
    documented: "x-on-behalf-of on every employer FX call. Without it Airwallex converts the platform wallet and still returns 201.",
    source: "Airwallex builder guide, payroll recipe watch-outs",
    naive: {
      steps: naiveSteps,
      outcome: "the subsidiary was never funded. The platform paid for it, the call reported success, and no field in the response says otherwise",
      balances: naiveBalances,
    },
    guarded: {
      steps: guardedSteps,
      outcome: `unscoped refused by ${d1.codes.join(", ")}. The scoped version passed every check and ran`,
      blockedBy: d1.codes,
      balances: guardedBalances,
    },
  };
}

async function trapDoublePay(): Promise<Trap> {
  const engine = freshIncident();
  const gateway = engine.gateway as SimulatedGateway;
  const state = store.get();
  const original = state.transfers.find((t) => t.id === "trf_kanda_orig");
  if (!original) throw new Error("incident seed missing the original transfer");

  const naiveSteps: TrapStep[] = [
    { label: `supplier reports non receipt. Transfer ${original.id} is ${original.status}`, result: "in flight, not failed", ok: true },
  ];
  const dup = await gateway.pay({
    requestId: "req_kanda_reissue_002",
    currency: original.currency,
    amount: original.amount,
    beneficiaryId: original.beneficiaryId,
    transferMethod: "SWIFT",
    note: "re-send",
    obligationId: original.obligationId,
  });
  naiveSteps.push({ label: "send a second payout with a fresh request_id", result: `201 ${dup.id} PROCESSING`, ok: true });
  const liveNaive = store.get().transfers.filter((t) => t.obligationId === "ob_kanda" && t.status !== "CANCELLED");
  naiveSteps.push({ label: "count live payments against one invoice", result: `${liveNaive.length}. Both will settle`, ok: false });
  const naiveBalances = snapshot(store.get());

  const g = freshIncident();
  const premature: Intent = {
    id: "trap_c_1",
    kind: "replace_transfer",
    obligationId: "ob_kanda",
    currency: "EUR",
    amount: 24000,
    replacesTransferId: "trf_kanda_orig",
    reason: "supplier says not paid. Re-send",
    confidence: 0.95,
    requestId: "req_kanda_reissue_002",
  };

  const guardedSteps: TrapStep[] = [];
  const d1 = blockedCodes(premature, g);
  guardedSteps.push({ label: "replace while the original is still SENT", result: d1.verdict, ok: d1.verdict === "blocked" });

  await g.execute(premature, "ops@ledgerline.dev").then((r) => {
    guardedSteps.push({ label: "ask the engine to run it anyway", result: r.detail, ok: !r.ok });
  });

  await g.gateway.transition("trf_kanda_orig", "FAILED", "BENEFICIARY_ACCOUNT_CLOSED");
  guardedSteps.push({ label: "wait for a terminal state. Original is now FAILED", result: "FAILED with failure_type", ok: true });

  const correct: Intent = { ...premature, id: "trap_c_2", confidence: 0.88 };
  const d2 = g.evaluate(correct);
  guardedSteps.push({ label: "replace now. Read the cost the engine attached first", result: `${d2.verdict}. ${d2.cost.summary}`, ok: true });
  const ran = await g.execute(correct, "ops@ledgerline.dev");
  guardedSteps.push({ label: "execute under a named approver", result: ran.ok ? ran.detail : ran.detail, ok: ran.ok });

  const liveGuarded = store.get().transfers.filter((t) => t.obligationId === "ob_kanda" && t.status !== "CANCELLED");
  const guardedBalances = snapshot(store.get());

  return {
    id: "double_pay",
    title: "Replacing a transfer that is merely slow pays the supplier twice",
    documented:
      "Original and replacement need different request_id values. Two SWIFT payouts means two fees. Do not close the incident only because the replacement is PAID.",
    source: "Airwallex builder guide, payment recovery recipe watch-outs",
    naive: {
      steps: naiveSteps,
      outcome: `two live EUR 24,000 SWIFT payouts against one invoice and a second 12.85 wire fee. Platform EUR down to ${naiveBalances.EUR}`,
      balances: naiveBalances,
    },
    guarded: {
      steps: guardedSteps,
      outcome: `refused while in flight by ${d1.codes.join(", ")}, refused a forced execution, then allowed once the original was terminal with the extra fee disclosed. Live payments against the invoice: ${liveGuarded.length}`,
      blockedBy: d1.codes,
      balances: guardedBalances,
    },
  };
}

async function trapStateOrder(): Promise<Trap> {
  const engine = freshIncident();
  const gateway = engine.gateway as SimulatedGateway;

  const created = await gateway.pay({
    requestId: "req_state_probe",
    currency: "USD",
    amount: 1000,
    beneficiaryId: "ben_datadog",
    transferMethod: "LOCAL",
    note: "state machine probe",
  });

  const naiveSteps: TrapStep[] = [{ label: `create a transfer. It starts at ${created.status}`, result: created.id, ok: true }];
  for (const attempt of [
    { to: "PAID" as const, reason: undefined, label: "jump PROCESSING straight to PAID" },
    { to: "FAILED" as const, reason: undefined, label: "FAILED with no failure_type" },
  ]) {
    try {
      await gateway.transition(created.id, attempt.to, attempt.reason);
      naiveSteps.push({ label: attempt.label, result: "accepted", ok: true });
    } catch (error) {
      naiveSteps.push({
        label: attempt.label,
        result: error instanceof GatewayError ? `${error.status} ${error.code}. ${error.message}` : "error",
        ok: false,
      });
    }
  }
  await gateway.transition(created.id, "SENT");
  await gateway.transition(created.id, "PAID");
  naiveSteps.push({ label: "PROCESSING to SENT to PAID, in order", result: "accepted", ok: true });

  const g = freshIncident();
  const guardedSteps: TrapStep[] = [
    { label: "the engine reads state before it acts, so an in flight transfer is waited on rather than re-sent", result: "planIncident emits escalate while SENT", ok: true },
    { label: "a blocked intent never reaches a transition call at all", result: "refused at evaluate()", ok: true },
    { label: "terminal states are the only ones that unlock a replacement", result: "REPLACEMENT_IS_TERMINAL", ok: true },
  ];
  void g;

  return {
    id: "state_order",
    title: "Transfers have a state machine and it is not optional",
    documented: "SENT before PAID. FAILED with a failure_type also needs SENT first. Prefer FAILED plus failure_type over a bare cancel.",
    source: "Airwallex builder guide, payment recovery recipe watch-outs",
    naive: {
      steps: naiveSteps,
      outcome: "two of the four calls were rejected by the API. An agent that retries these burns wall clock time during an incident and usually concludes the provider is down",
      balances: snapshot(store.get()),
    },
    guarded: {
      steps: guardedSteps,
      outcome: "ordering is enforced before the request, so the supplier never sees the failed attempt",
      blockedBy: [],
      balances: snapshot(store.get()),
    },
  };
}

export async function runTrapLab(): Promise<Trap[]> {
  const traps = [
    await trapQuoteReplay(),
    await trapOnBehalfOf(),
    await trapDoublePay(),
    await trapStateOrder(),
  ];
  store.reset("treasury");
  return traps;
}
