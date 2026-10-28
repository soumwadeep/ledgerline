"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/* ------------------------------------------------------------------ views */

interface WalletView {
  id: string;
  label: string;
  balances: Record<string, number>;
}

interface ObligationView {
  id: string;
  payee: string;
  beneficiaryId: string;
  currency: string;
  amount: number;
  dueInDays: number;
  transferMethod: "LOCAL" | "SWIFT";
  criticality: string;
  maxDeferrableDays: number;
  status: string;
  deferredDays: number;
  fundedBy?: string;
}

interface TransferView {
  id: string;
  requestId: string;
  obligationId?: string;
  currency: string;
  amount: number;
  fee: number;
  status: string;
  failureReason?: string;
  supersedes?: string;
}

interface CheckView {
  code: string;
  label: string;
  passed: boolean;
  severity: string;
  detail: string;
}

interface IntentView {
  id: string;
  kind: string;
  obligationId?: string;
  currency: string;
  to?: string;
  amount: number;
  reason: string;
  confidence: number;
  requestId: string;
  onBehalfOf?: string;
  replacesTransferId?: string;
  quoteId?: string;
}

interface DecisionView {
  intentId: string;
  verdict: "auto_execute" | "escalate" | "blocked";
  checks: CheckView[];
  reversibility: string;
  cost: { fee: number; penalty: number; summary: string };
  simulation: { ok: boolean; balancesAfter: Record<string, number>; note: string };
  rationale: string;
  approvedBy?: string;
}

interface StateView {
  scenario: "treasury" | "incident";
  gatewayMode: "sim" | "airwallex";
  gatewayWarning: string | null;
  agentMode: "claude" | "deterministic";
  policy: {
    reserveFloors: Record<string, number>;
    maxSinglePayout: number;
    approvedBeneficiaries: string[];
    swiftFee: { amount: number; currency: string };
  };
  wallets: WalletView[];
  obligations: ObligationView[];
  transfers: TransferView[];
  pending: { intent: IntentView; decision: DecisionView | null }[];
  ledgerLength: number;
}

interface CycleResult {
  intent: IntentView;
  decision: DecisionView;
  outcome?: string;
}

interface CycleResponse {
  source: string;
  notes: string[];
  signature: string;
  results: CycleResult[];
}

interface TrapStep {
  label: string;
  result: string;
  ok: boolean;
}

interface Trap {
  id: string;
  title: string;
  documented: string;
  source: string;
  naive: { steps: TrapStep[]; outcome: string };
  guarded: { steps: TrapStep[]; outcome: string; blockedBy: string[] };
}

interface LedgerRecord {
  seq: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
  hash: string;
}

interface LedgerResponse {
  records: LedgerRecord[];
  verification: { ok: boolean; length: number; brokenAt?: number };
  tamperProof: { ok: boolean; brokenAt?: number };
}

/* -------------------------------------------------------------- utilities */

function money(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

/* ----------------------------------------------------------------- panels */

function Runway({ state }: { state: StateView }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Liquidity runway</h2>
        <span className="meta">{state.wallets.length} wallets</span>
      </div>
      <div className="panel-body">
        {state.wallets.map((wallet) => (
          <div className="wallet" key={wallet.id}>
            <div className="wallet-name">
              <span>{wallet.label}</span>
              <span>{wallet.id === "platform" ? "own account" : "connected"}</span>
            </div>
            {Object.entries(wallet.balances).map(([currency, balance]) => {
              const floor = state.policy.reserveFloors[currency] ?? 0;
              const reference = Math.max(floor * 3, balance, 1);
              const breached = balance < floor;
              return (
                <div key={currency}>
                  <div className="bal-row">
                    <span className="ccy">{currency}</span>
                    <div className="meter">
                      <i className={breached ? "breach" : ""} style={{ width: `${Math.min(100, (balance / reference) * 100)}%` }} />
                      <u style={{ left: `${(floor / reference) * 100}%` }} />
                    </div>
                    <span className="amt">{money(balance)}</span>
                  </div>
                  <div className="floor-label" style={{ marginBottom: 8 }}>
                    reserve floor {money(floor)} · spendable {money(Math.max(0, balance - floor))}
                    {breached ? " · BELOW FLOOR" : ""}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

function Book({ state }: { state: StateView }) {
  const total = state.obligations
    .filter((o) => o.status !== "paid")
    .reduce((sum, o) => sum + (o.currency === "USD" ? o.amount : o.currency === "EUR" ? o.amount * 1.09 : o.amount * 0.78), 0);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Open obligations</h2>
        <span className="meta">≈ {money(total)} USD equivalent unsettled</span>
      </div>
      <div className="panel-body">
        <table className="book">
          <thead>
            <tr>
              <th>Payee</th>
              <th>Type</th>
              <th style={{ textAlign: "right" }}>Amount</th>
              <th style={{ textAlign: "right" }}>Due</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {state.obligations.map((o) => (
              <tr key={o.id}>
                <td className="payee">
                  {o.payee}
                  {o.fundedBy ? <span className="tag" style={{ marginLeft: 6 }}>scoped</span> : null}
                </td>
                <td>
                  <span className={`tag ${o.criticality}`}>{o.criticality}</span>
                </td>
                <td className="num">
                  {money(o.amount)} {o.currency}
                  {o.transferMethod === "SWIFT" ? " +wire" : ""}
                </td>
                <td className="num">{o.dueInDays}d</td>
                <td>
                  <span className={`status ${o.status}`}>
                    {o.status}
                    {o.status === "deferred" ? ` +${o.deferredDays}d` : ""}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function IntentCard({
  intent,
  decision,
  outcome,
  busy,
  onDecide,
}: {
  intent: IntentView;
  decision: DecisionView | null;
  outcome?: string;
  busy: boolean;
  onDecide?: (action: "approve" | "reject") => void;
}) {
  const failed = decision?.checks.filter((c) => !c.passed) ?? [];
  const passed = decision?.checks.filter((c) => c.passed) ?? [];

  return (
    <article className={`intent ${decision?.verdict ?? ""}`}>
      <div className="intent-top">
        <span className={`kind ${intent.kind}`}>{intent.kind.replace("_", " ")}</span>
        {decision ? <span className={`verdict ${decision.verdict}`}>{decision.verdict.replace("_", " ")}</span> : null}
      </div>

      <div className="intent-amount">
        {money(intent.amount)}
        <small>{intent.currency}</small>
        {intent.to ? (
          <>
            <span style={{ color: "var(--ink-faint)", margin: "0 6px" }}>→</span>
            {money(decision?.simulation.balancesAfter[intent.to] ?? 0)}
            <small>{intent.to}</small>
          </>
        ) : null}
      </div>

      <p className="intent-reason">{intent.reason}</p>

      {decision ? (
        <>
          <div className="checks">
            {passed.map((c) => (
              <span className="check pass" key={c.code} title={c.label}>
                {c.code}
              </span>
            ))}
            {failed.map((c) => (
              <span className={`check ${c.severity === "block" ? "fail" : "warn"}`} key={c.code} title={c.detail}>
                {c.code}
              </span>
            ))}
          </div>

          <details className="why">
            <summary>why this verdict</summary>
            {failed.length === 0 ? (
              <div className="check-detail">
                <b>All {decision.checks.length} checks passed.</b> {decision.cost.summary}
              </div>
            ) : (
              failed.map((c) => (
                <div className="check-detail" key={c.code}>
                  <b>{c.code}</b> · {c.label}
                  <br />
                  {c.detail}
                </div>
              ))
            )}
            <div className="check-detail">
              <b>reversibility</b> {decision.reversibility} · <b>cost</b> {decision.cost.summary}
            </div>
            <div className="check-detail">
              <b>projected balances</b>{" "}
              {Object.entries(decision.simulation.balancesAfter)
                .map(([k, v]) => `${k} ${money(v)}`)
                .join("  ·  ")}
            </div>
          </details>

          <div className="agent-note">
            <b>agent said</b> confidence {intent.confidence.toFixed(2)} · request id {intent.requestId}
            <br />
            <b>engine did</b> {outcome ?? (decision.verdict === "escalate" ? "awaiting a person" : "decided from state, not from this text")}
          </div>

          {decision.verdict === "escalate" && onDecide ? (
            <div className="approve-row">
              <button className="primary mini" disabled={busy} onClick={() => onDecide("approve")}>
                approve
              </button>
              <button className="danger mini" disabled={busy} onClick={() => onDecide("reject")}>
                decline
              </button>
              <span className="floor-label">irreversible above the auto cap. nothing moves until you click</span>
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

function TrapPanel({ traps }: { traps: Trap[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Trap lab</h2>
        <span className="meta">same call, with and without the engine</span>
      </div>
      <div className="panel-body">
        {traps.map((trap) => (
          <article className="trap" key={trap.id}>
            <div className="trap-head">
              <h3>{trap.title}</h3>
              <div className="trap-doc">
                “{trap.documented}”
                <br />— {trap.source}
              </div>
            </div>
            <div className="trap-cols">
              <div className="trap-col naive">
                <h4>agent with api keys</h4>
                {trap.naive.steps.map((s, i) => (
                  <div className="step" key={i}>
                    <span className="mark">{s.ok ? "→" : "×"}</span>
                    <span>
                      {s.label}
                      <em>{s.result}</em>
                    </span>
                  </div>
                ))}
                <div className="trap-outcome">{trap.naive.outcome}</div>
              </div>
              <div className="trap-col guarded">
                <h4>agent behind ledgerline</h4>
                {trap.guarded.steps.map((s, i) => (
                  <div className="step" key={i}>
                    <span className="mark">{s.ok ? "✓" : "×"}</span>
                    <span>
                      {s.label}
                      <em>{s.result}</em>
                    </span>
                  </div>
                ))}
                <div className="trap-outcome">{trap.guarded.outcome}</div>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function LedgerPanel({ ledger }: { ledger: LedgerResponse | null }) {
  if (!ledger) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Decision ledger</h2>
        <span className="meta">{ledger.records.length} records, hash chained</span>
      </div>
      <div className="panel-body">
        <div className={`verify ${ledger.verification.ok ? "" : "bad"}`}>
          <span className="dot" />
          {ledger.verification.ok
            ? `chain verified across ${ledger.verification.length} records`
            : `chain broken at record ${ledger.verification.brokenAt}`}
        </div>
        <div className="verify bad" style={{ borderColor: "#4a3a14", background: "#14100a", color: "var(--amber)" }}>
          <span className="dot" />
          tampering with record {ledger.tamperProof.brokenAt} is detected: {ledger.tamperProof.ok ? "no" : "yes"}
        </div>
        <div style={{ maxHeight: 380, overflowY: "auto" }}>
          {ledger.records
            .slice()
            .reverse()
            .map((record) => (
              <div className="ledger-row" key={record.seq}>
                <span className="ledger-seq">{record.seq}</span>
                <span className={`ledger-kind ${record.kind}`}>{record.kind}</span>
                <span className="ledger-payload">
                  {Object.entries(record.payload)
                    .filter(([k]) => k !== "agentReason")
                    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                    .join(" ")}
                  <br />
                  <span className="hash">{record.hash.slice(0, 24)}…</span>
                </span>
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- dashboard */

export default function Dashboard() {
  const [state, setState] = useState<StateView | null>(null);
  const [cycle, setCycle] = useState<CycleResponse | null>(null);
  const [traps, setTraps] = useState<Trap[] | null>(null);
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [signature, setSignature] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<{ ok: boolean; steps: { name: string; ok: boolean; detail: string }[]; hint: string } | null>(null);
  const [depositAmount, setDepositAmount] = useState(40000);
  const [depositCurrency, setDepositCurrency] = useState("USD");
  const [approver, setApprover] = useState("ops@ledgerline.dev");

  const refresh = useCallback(async () => {
    const next = await json<StateView>("/api/state");
    setState(next);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e instanceof Error ? e.message : "failed to load state"));
  }, [refresh]);

  const guard = useCallback(
    async (label: string, run: () => Promise<void>) => {
      setBusy(true);
      setError(null);
      try {
        await run();
      } catch (e) {
        setError(`${label}: ${e instanceof Error ? e.message : "unknown error"}`);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const runCycle = () =>
    guard("decision cycle", async () => {
      const response = await json<CycleResponse>("/api/cycle", {
        method: "POST",
        body: JSON.stringify({ reopenOnly: signature }),
      });
      setCycle(response);
      setSignature(response.signature);
      await refresh();
    });

  const deposit = () =>
    guard("deposit", async () => {
      await json("/api/deposit", {
        method: "POST",
        body: JSON.stringify({ currency: depositCurrency, amount: depositAmount, payerName: "Customer settlement" }),
      });
      await refresh();
    });

  const decide = (intentId: string, action: "approve" | "reject") =>
    guard(action, async () => {
      await json("/api/decision", { method: "POST", body: JSON.stringify({ intentId, action, by: approver }) });
      await refresh();
    });

  const loadTraps = () =>
    guard("trap lab", async () => {
      const response = await json<{ ok: boolean; traps: Trap[] }>("/api/traps");
      setTraps(response.traps);
      await refresh();
    });

  const loadLedger = () =>
    guard("ledger", async () => {
      setLedger(await json<LedgerResponse>("/api/ledger"));
    });

  const runScenario = (scenario: "treasury" | "incident") =>
    guard("scenario", async () => {
      await json("/api/reset", { method: "POST", body: JSON.stringify({ scenario }) });
      setCycle(null);
      setSignature(undefined);
      setTraps(null);
      setLedger(null);
      await refresh();
    });

  const diagnose = () =>
    guard("diagnose", async () => {
      setDiagnostic(await json("/api/diagnose?mutate=1"));
    });

  const escalated = useMemo(() => state?.pending ?? [], [state]);

  if (!state) {
    return (
      <div className="shell">
        <p className="empty pulse">connecting to the treasury desk…</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="masthead">
        <div>
          <div className="wordmark">
            <span className="rule" />
            <h1>Ledgerline</h1>
          </div>
          <p className="tagline">
            The model proposes. The engine decides. Only the engine touches money.
          </p>
        </div>
        <div className="chips">
          <span className={`chip ${state.gatewayMode === "airwallex" ? "live" : "sim"}`}>
            <span className="dot" /> {state.gatewayMode === "airwallex" ? "airwallex sandbox" : "local simulation"}
          </span>
          <span className="chip">
            proposer <b>{state.agentMode}</b>
          </span>
          <span className="chip">
            scenario <b>{state.scenario}</b>
          </span>
          <span className="chip">
            ledger <b>{state.ledgerLength}</b>
          </span>
        </div>
      </header>

      {state.gatewayWarning ? <div className="notice">{state.gatewayWarning}</div> : null}

      {error ? <div className="notice">{error}</div> : null}

      <div className="panel">
        <div className="panel-head">
          <h2>Desk controls</h2>
          <span className="meta">auto execute cap {money(state.policy.maxSinglePayout)} · wire fee {money(state.policy.swiftFee.amount)} {state.policy.swiftFee.currency}</span>
        </div>
        <div className="panel-body">
          <div className="controls">
            <div className="seg">
              <button onClick={() => runScenario("treasury")} disabled={busy} aria-pressed={state.scenario === "treasury"}>
                kit 01 treasury
              </button>
              <button onClick={() => runScenario("incident")} disabled={busy} aria-pressed={state.scenario === "incident"}>
                kit 03 incident
              </button>
            </div>
            <button className="primary" onClick={runCycle} disabled={busy}>
              run decision cycle
            </button>
            <input type="number" value={depositAmount} onChange={(e) => setDepositAmount(Number(e.target.value))} aria-label="deposit amount" />
            <input type="text" value={depositCurrency} onChange={(e) => setDepositCurrency(e.target.value.toUpperCase())} style={{ width: 62 }} aria-label="deposit currency" />
            <button onClick={deposit} disabled={busy}>
              simulate deposit
            </button>
            <button className="ghost" onClick={loadTraps} disabled={busy}>
              run trap lab
            </button>
            <button className="ghost" onClick={loadLedger} disabled={busy}>
              read ledger
            </button>
            <button className="ghost" onClick={diagnose} disabled={busy}>
              diagnose api
            </button>
            <input type="text" value={approver} onChange={(e) => setApprover(e.target.value)} style={{ width: 190 }} aria-label="approver identity" />
          </div>
          {diagnostic ? (
            <div style={{ marginTop: 12 }}>
              {diagnostic.steps.map((s) => (
                <div className="step" key={s.name}>
                  <span className="mark">{s.ok ? "✓" : "×"}</span>
                  <span>
                    {s.name}
                    <em>{s.detail}</em>
                  </span>
                </div>
              ))}
              <div className="notice" style={{ marginTop: 8 }}>{diagnostic.hint}</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid">
        <div>
          <Runway state={state} />
          <Book state={state} />
          <section className="panel">
            <div className="panel-head">
              <h2>Transfers</h2>
              <span className="meta">{state.transfers.length} on the wire</span>
            </div>
            <div className="panel-body">
              {state.transfers.length === 0 ? (
                <p className="empty">nothing has moved yet</p>
              ) : (
                state.transfers.map((t) => (
                  <div className="kv" key={t.id}>
                    <span>
                      {t.obligationId ?? t.id}
                      {t.supersedes ? " (replaces)" : ""}
                    </span>
                    <span>
                      {money(t.amount)} {t.currency} ·{" "}
                      <span className={`status ${t.status === "PAID" ? "paid" : t.status === "FAILED" ? "deferred" : "unsettled"}`}>{t.status}</span>
                      {t.fee ? ` · fee ${money(t.fee)}` : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div>
          <section className="panel">
            <div className="panel-head">
              <h2>{state.scenario === "incident" ? "Incident queue" : "Decision queue"}</h2>
              <span className="meta">{cycle ? `${cycle.results.length} intents · proposed by ${cycle.source}` : "awaiting a cycle"}</span>
            </div>
            <div className="panel-body">
              {cycle?.notes.length ? (
                <div className="notice" style={{ marginBottom: 12 }}>
                  {cycle.notes.map((n) => (
                    <div key={n}>· {n}</div>
                  ))}
                </div>
              ) : null}
              {cycle && cycle.results.length ? (
                cycle.results.map((r) => (
                  <IntentCard key={r.intent.id} intent={r.intent} decision={r.decision} outcome={r.outcome} busy={busy} />
                ))
              ) : (
                <p className="empty">run a decision cycle to see what the agent proposes and what the engine allows</p>
              )}
            </div>
          </section>

          {escalated.length ? (
            <section className="panel">
              <div className="panel-head">
                <h2>Awaiting a person</h2>
                <span className="meta">{escalated.length} queued</span>
              </div>
              <div className="panel-body">
                {escalated.map(({ intent, decision }) => (
                  <IntentCard
                    key={intent.id}
                    intent={intent}
                    decision={decision}
                    busy={busy}
                    onDecide={(action) => decide(intent.id, action)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {traps ? <TrapPanel traps={traps} /> : null}
        </div>

        <div>
          <section className="panel">
            <div className="panel-head">
              <h2>Standing policy</h2>
              <span className="meta">in code, not in a prompt</span>
            </div>
            <div className="panel-body">
              {Object.entries(state.policy.reserveFloors).map(([currency, floor]) => (
                <div className="kv" key={currency}>
                  <span>{currency} reserve floor</span>
                  <span>{money(floor)}</span>
                </div>
              ))}
              <div className="kv">
                <span>auto execute cap</span>
                <span>{money(state.policy.maxSinglePayout)}</span>
              </div>
              <div className="kv">
                <span>human approval at</span>
                <span>irreversible</span>
              </div>
              <div className="kv">
                <span>approved payees</span>
                <span>{state.policy.approvedBeneficiaries.length}</span>
              </div>
              <div className="kv">
                <span>quote use limit</span>
                <span>1</span>
              </div>
              <div className="kv">
                <span>fx quote</span>
                <span>{signature ? "fingerprint held" : "none yet"}</span>
              </div>
            </div>
          </section>

          {ledger ? <LedgerPanel ledger={ledger} /> : null}
        </div>
      </div>

      <footer className="footnote">
        Ledgerline · built for the Airwallex Agentic Banking Hackathon against starter kits 01 and 03. Every behaviour the trap lab
        demonstrates is quoted from Airwallex&apos;s own builder guide. With no credentials configured the desk runs on a local
        simulation of the documented sandbox contract, traps included, so the guardrail is testable offline; set{" "}
        <code>LEDGERLINE_GATEWAY=airwallex</code> to run the identical engine against the real sandbox.
      </footer>
    </div>
  );
}
