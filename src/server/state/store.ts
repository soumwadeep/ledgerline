import type { Obligation, PolicyConfig, Wallet, WorldState } from "../types";

/**
 * In memory world state for one running demo.
 *
 * Deliberately not a database. The demo is a single treasury desk and the
 * tamper evidence the product claims comes from the hash chained decision
 * ledger, not from a storage engine. A restart reseeds the scenario.
 */

export const RATES: Record<string, number> = {
  "SGD/USD": 0.78,
  "USD/SGD": 1.28,
  "EUR/USD": 1.09,
  "USD/EUR": 0.92,
  "SGD/EUR": 0.71,
  "EUR/SGD": 1.41,
  "USD/USD": 1,
  "EUR/EUR": 1,
  "SGD/SGD": 1,
};

export function rate(sell: string, buy: string): number {
  const direct = RATES[`${sell}/${buy}`];
  if (direct !== undefined) return direct;
  throw new Error(`No rate configured for ${sell} to ${buy}`);
}

function wallet(id: string, label: string, balances: Record<string, number>): Wallet {
  return { id, label, balances };
}

function obligation(o: Partial<Obligation> & Pick<Obligation, "id" | "payee" | "currency" | "amount">): Obligation {
  return {
    beneficiaryId: o.beneficiaryId ?? `ben_${o.id}`,
    dueInDays: o.dueInDays ?? 5,
    transferMethod: o.transferMethod ?? "LOCAL",
    latePenaltyPerDay: o.latePenaltyPerDay ?? 0,
    criticality: o.criticality ?? "supplier",
    maxDeferrableDays: o.maxDeferrableDays ?? 5,
    status: "unsettled",
    deferredDays: 0,
    ...o,
  } as Obligation;
}

export const DEFAULT_POLICY: PolicyConfig = {
  reserveFloors: { USD: 15000, EUR: 6000, SGD: 3000 },
  maxSinglePayout: 25000,
  approvedBeneficiaries: [
    "ben_payroll_us",
    "ben_kanda_components",
    "ben_revenue_cms",
    "ben_datadog",
    "ben_lender_instalment",
  ],
  humanApprovalAt: "irreversible",
  swiftFee: { amount: 12.85, currency: "EUR" },
  localFee: { amount: 0, currency: "USD" },
  quoteUseLimit: 1,
};

export function seedTreasury(): WorldState {
  return {
    wallets: [
      wallet("platform", "Platform operating wallet", { USD: 42000, EUR: 18500, SGD: 11000 }),
      // A connected account. Money that belongs to it must never move on the
      // platform's own balance, which is exactly what happens if a call omits
      // x-on-behalf-of.
      wallet("acct_eu_subsidiary", "EU subsidiary (connected account)", { EUR: 16000 }),
    ],
    obligations: [
      obligation({
        id: "ob_payroll",
        payee: "US payroll run",
        beneficiaryId: "ben_payroll_us",
        currency: "USD",
        amount: 31000,
        dueInDays: 2,
        criticality: "payroll",
        maxDeferrableDays: 0,
        latePenaltyPerDay: 400,
      }),
      obligation({
        id: "ob_kanda",
        payee: "Kanda Components",
        beneficiaryId: "ben_kanda_components",
        currency: "EUR",
        amount: 24000,
        dueInDays: 4,
        transferMethod: "SWIFT",
        criticality: "supplier",
        maxDeferrableDays: 10,
        latePenaltyPerDay: 180,
      }),
      obligation({
        id: "ob_vat",
        payee: "EU VAT return",
        beneficiaryId: "ben_revenue_cms",
        currency: "EUR",
        amount: 9500,
        dueInDays: 6,
        criticality: "tax",
        maxDeferrableDays: 0,
        latePenaltyPerDay: 240,
        // Owned by the connected account. Any call for this obligation that
        // omits x-on-behalf-of silently drains the platform wallet instead.
        fundedBy: "acct_eu_subsidiary",
      }),
      obligation({
        id: "ob_datadog",
        payee: "Datadog annual renewal",
        beneficiaryId: "ben_datadog",
        currency: "USD",
        amount: 14400,
        dueInDays: 9,
        criticality: "saas",
        maxDeferrableDays: 20,
        latePenaltyPerDay: 0,
      }),
      obligation({
        id: "ob_lender",
        payee: "Lender instalment",
        beneficiaryId: "ben_lender_instalment",
        currency: "USD",
        amount: 6200,
        dueInDays: 1,
        criticality: "lender",
        maxDeferrableDays: 3,
        latePenaltyPerDay: 90,
      }),
    ],
    transfers: [],
    quotes: [],
    pendingIntents: [],
    decisions: {},
    consumedQuotes: {},
    settlementKeys: {},
  };
}

/**
 * Kit 03. A supplier transfer already went out and the supplier says it never
 * arrived. The interesting part is that the naive fix, sending it again, is the
 * one that costs twice.
 */
export function seedIncident(): WorldState {
  const state = seedTreasury();
  state.wallets[0].balances = { USD: 68000, EUR: 34000, SGD: 11000 };
  state.obligations = state.obligations.filter((o) => o.id !== "ob_kanda");
  state.transfers = [
    {
      id: "trf_kanda_orig",
      requestId: "req_kanda_orig_001",
      obligationId: "ob_kanda",
      currency: "EUR",
      amount: 24000,
      fee: 12.85,
      beneficiaryId: "ben_kanda_components",
      status: "SENT",
      createdAt: new Date().toISOString(),
    },
  ];
  state.obligations.unshift(
    obligation({
      id: "ob_kanda",
      payee: "Kanda Components",
      beneficiaryId: "ben_kanda_components",
      currency: "EUR",
      amount: 24000,
      dueInDays: -1,
      transferMethod: "SWIFT",
      criticality: "supplier",
      maxDeferrableDays: 10,
      latePenaltyPerDay: 180,
      status: "unsettled",
    }),
  );
  return state;
}

class Store {
  private state: WorldState = seedTreasury();
  policy: PolicyConfig = DEFAULT_POLICY;
  scenario: "treasury" | "incident" = "treasury";

  get(): WorldState {
    return this.state;
  }

  reset(scenario: "treasury" | "incident" = this.scenario): WorldState {
    this.scenario = scenario;
    this.state = scenario === "incident" ? seedIncident() : seedTreasury();
    this.policy = { ...DEFAULT_POLICY };
    return this.state;
  }

  replace(next: WorldState): void {
    this.state = next;
  }
}

/**
 * Module singleton. Next.js dev mode re-evaluates modules on hot reload, so the
 * instance is parked on globalThis to survive it.
 */
const globalStore = globalThis as unknown as { __ledgerlineStore?: Store };
export const store: Store = globalStore.__ledgerlineStore ?? (globalStore.__ledgerlineStore = new Store());

export function findObligation(state: WorldState, id?: string): Obligation | undefined {
  return state.obligations.find((o) => o.id === id);
}

export function platformWallet(state: WorldState): Wallet {
  return state.wallets[0];
}

export function balanceOf(state: WorldState, currency: string, onBehalfOf?: string): number {
  const wallet = onBehalfOf
    ? state.wallets.find((w) => w.id === onBehalfOf) ?? state.wallets[0]
    : state.wallets[0];
  return wallet.balances[currency] ?? 0;
}

/** Balance net of the reserve floor that must remain untouched. */
export function availableBalance(wallet: Wallet, currency: string, policy: PolicyConfig): number {
  return (wallet.balances[currency] ?? 0) - (policy.reserveFloors[currency] ?? 0);
}
