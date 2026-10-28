/**
 * Ledgerline domain types.
 *
 * Amounts are in MAJOR units, not cents. This matches Airwallex, where
 * 25000 means twenty five thousand dollars. Getting this wrong is the single
 * most common way an agent moves a hundred times more money than intended.
 */

export type Currency = string;

export type Criticality = "payroll" | "tax" | "supplier" | "lender" | "saas";

export type TransferMethod = "LOCAL" | "SWIFT";

export type ObligationStatus =
  | "unsettled"
  | "paid"
  | "deferred"
  | "escalated";

export interface Obligation {
  id: string;
  payee: string;
  beneficiaryId: string;
  currency: Currency;
  /** Amount owed, major units. */
  amount: number;
  /** Days until due. Negative means already overdue. */
  dueInDays: number;
  transferMethod: TransferMethod;
  /** Penalty accrued per day of delay, major units, same currency. */
  latePenaltyPerDay: number;
  criticality: Criticality;
  /** How many days this obligation may legally slip before it becomes a breach. */
  maxDeferrableDays: number;
  status: ObligationStatus;
  deferredDays: number;
  settledByTransferId?: string;
  /**
   * Which wallet is supposed to fund this. If set, every call for this
   * obligation must carry x-on-behalf-of or Airwallex books it on the platform
   * wallet and still returns 201.
   */
  fundedBy?: string;
}

export interface Wallet {
  /** "platform" for the own account, otherwise a connected account id. */
  id: string;
  label: string;
  balances: Record<Currency, number>;
}

export type IntentKind =
  | "fund"
  | "convert"
  | "defer"
  | "escalate"
  | "replace_transfer";

export interface Intent {
  id: string;
  kind: IntentKind;
  /** Obligation this intent settles, defers or escalates. */
  obligationId?: string;
  /** Currency the amount is denominated in. For convert this is the sold currency. */
  currency: Currency;
  /** For convert. */
  from?: Currency;
  to?: Currency;
  amount: number;
  /**
   * The agent's own explanation. The engine reads it for the audit trail and
   * ignores it for every decision. An agent that lies here changes nothing.
   */
  reason: string;
  /** Agent reported confidence, 0 to 1. Also advisory only. */
  confidence: number;
  /** Idempotency key the agent intends to send. */
  requestId: string;
  /**
   * Connected account the action should act on. When set, the gateway call
   * must carry x-on-behalf-of or Airwallex silently acts on the platform
   * wallet and still returns 201.
   */
  onBehalfOf?: string;
  /** For replace_transfer, the transfer being replaced. */
  replacesTransferId?: string;
  /** For convert, the quote this intent is bound to. */
  quoteId?: string;
}

export type Reversibility = "reversible" | "costly" | "irreversible";

export type Severity = "pass" | "warn" | "escalate" | "block";

export interface PolicyCheck {
  code: string;
  label: string;
  passed: boolean;
  severity: Severity;
  detail: string;
}

export type Verdict = "auto_execute" | "escalate" | "blocked";

export interface CostEstimate {
  /** Fee the action itself incurs, in the action currency. */
  fee: number;
  feeCurrency: Currency;
  /** Anything the action forfeits, for example late penalty from deferring. */
  penalty: number;
  summary: string;
}

export interface Decision {
  intentId: string;
  verdict: Verdict;
  checks: PolicyCheck[];
  reversibility: Reversibility;
  cost: CostEstimate;
  /** What the gateway would do if this ran, produced before anything is sent. */
  simulation: SimulationResult;
  rationale: string;
  decidedAt: string;
  /** Set when a human approves an escalated intent. */
  approvedBy?: string;
}

export interface SimulationResult {
  ok: boolean;
  balancesAfter: Record<Currency, number>;
  note: string;
}

export interface PolicyConfig {
  /** Minimum balance that must remain per currency. */
  reserveFloors: Record<Currency, number>;
  /** Largest single payout the agent may execute without a human. */
  maxSinglePayout: number;
  /** Payees the agent is allowed to pay at all. */
  approvedBeneficiaries: string[];
  /** Reversibility at or above which a human is required. */
  humanApprovalAt: Reversibility;
  /** SWIFT wire fee, per the builder guide example. */
  swiftFee: { amount: number; currency: Currency };
  /** LOCAL rails carry no fee. Kept explicit so nobody hardcodes it. */
  localFee: { amount: number; currency: Currency };
  /** How many FX conversions per quote id the engine will tolerate. Always 1. */
  quoteUseLimit: number;
}

export interface LedgerRecord {
  seq: number;
  ts: string;
  kind:
    | "decision"
    | "execution"
    | "approval"
    | "block"
    | "deposit"
    | "transition"
    | "reset";
  payload: unknown;
  prevHash: string;
  hash: string;
}

export interface TransferRecord {
  id: string;
  requestId: string;
  obligationId?: string;
  currency: Currency;
  amount: number;
  fee: number;
  beneficiaryId: string;
  status: "PROCESSING" | "SENT" | "PAID" | "FAILED" | "CANCELLED";
  failureReason?: string;
  createdAt: string;
  /** Transfers this one supersedes. Used to prove nothing was paid twice. */
  supersedes?: string;
}

export interface QuoteRecord {
  id: string;
  from: Currency;
  to: Currency;
  sell: number;
  buy: number;
  rate: number;
  /** Number of times this quote has been converted against. */
  usedBy: string[];
}

export interface WorldState {
  wallets: Wallet[];
  obligations: Obligation[];
  transfers: TransferRecord[];
  quotes: QuoteRecord[];
  pendingIntents: Intent[];
  decisions: Record<string, Decision>;
  /** quote id -> request ids that converted it. Engine side truth. */
  consumedQuotes: Record<string, string[]>;
  /** obligation id -> request ids already used to settle it. */
  settlementKeys: Record<string, string[]>;
}
