# Ledgerline

**A deterministic guardrail between AI agents and Airwallex money movement.**

The model proposes. The engine decides. Only the engine touches money.

Built for the [Airwallex Agentic Banking Hackathon](https://airwallex.hackerearth.com/), against starter kits **01 (Adaptive Treasury Controller)** and **03 (Payment Ops Incident Commander)**.

---

## The problem

Agents are being handed payment credentials before anyone has settled what happens when they are wrong. Their failure mode is not bad arithmetic. It is bad authority.

Airwallex's own [builder guide](https://airwallexdev.com/) documents four behaviours that an agent holding API keys will walk straight into, each one returning a success code:

| Documented behaviour | What an unguarded agent does |
| --- | --- |
| "Treat a quote as single use in your code. Airwallex will accept the same `quote_id` again with a new `request_id`." | Converts the same quote twice, paying a rate that was only ever priced once |
| "Without it Airwallex converts the platform wallet and still returns 201." | Believes a connected account was topped up while the parent company's cash quietly paid for it |
| "Two SWIFT payouts means two fees. Don't close the incident only because the replacement is PAID." | Re-sends a transfer that was merely slow, producing two live payments against one invoice |
| "SENT before PAID. `FAILED` with a `failure_type` also needs SENT first." | Retries a rejected transition, burns wall clock during an incident, concludes the provider is down |

Prompt hygiene does not fix any of these. A boundary does.

## The claim, and how to disprove it

Every one of those four is a **failing test** in this repository. Run it:

```bash
npm install
npm test
```

27 tests pass with no credentials, no network, and no model. Each trap is asserted twice: once showing that the documented API permits it, once showing that the engine refuses it.

```
✓ refuses to convert the same FX quote twice even with a fresh request id
✓ refuses a payment scoped to a connected account when x-on-behalf-of is missing
✓ refuses to replace a transfer that is in flight rather than failed
✓ allows a replacement once the original is terminal, and prices the second fee
✓ refuses a replacement that reuses the original request id
✓ catches cents versus major units before it moves a hundred times too much
✓ will not let an agent invent a payee
✓ never breaches a reserve floor while doing it
```

## Run it

```bash
npm install
npm run dev      # http://localhost:3111
```

The desk opens on a seeded treasury that is deliberately short of cash. Press **run decision cycle**, then **run trap lab**.

Nothing needs configuring. Without credentials the money layer runs on a local simulation of the documented sandbox contract, traps included, so the guardrail is testable offline. The engine is identical either way.

### Against the real sandbox

Create `.env.local` from `.env.example` and add your own sandbox credentials (Sandbox web app → Account → Developer → API keys):

```bash
LEDGERLINE_GATEWAY=airwallex
AIRWALLEX_CLIENT_ID=...
AIRWALLEX_API_KEY=...
```

Then press **diagnose api**, which walks the documented endpoint sequence in order and reports the first step that fails and why. The guide's advice is "if you can't, say what's missing"; that is this, as a button.

### With a model in the loop

Set `ANTHROPIC_API_KEY` and the proposer switches from the deterministic allocator to Claude. This changes nothing about what is allowed to happen: the model emits the same typed intents, they are validated against the world state before the engine sees them, and the engine decides exactly as it does today. Without the key the product is complete.

---

## How it is arranged

Three layers, and the privilege decreases as you go up.

**Money layer** — `src/server/gateway/`
`SimulatedGateway` and `AirwallexGateway` implement one interface: balances, global accounts, simulated deposits, FX rates, quotes, conversions, beneficiaries, transfers, and simulated transfer transitions. The real client bakes in the operational details that are easy to get wrong: the token lasts 30 minutes, FX calls must not carry `x-api-version`, amounts are major units, every mutation needs a stable `request_id`.

**Policy layer** — `src/server/engine/`
A typed intent schema (`fund`, `convert`, `defer`, `escalate`, `replace_transfer`). Each intent is projected against live ledger state and checked against a reserve floor, per-currency exposure, quote consumption, required headers, an idempotency key, a payee allowlist, an amount-scale sanity bound, and a reversibility classification of reversible / costly / irreversible. The verdict is `auto_execute`, `escalate`, or `blocked`.

`execute()` refuses a blocked intent even when called directly with an approver. That is asserted in the test suite, because an invariant you cannot test is a convention.

**Agent layer** — `src/server/agent/`
The allocator ranks obligations under a cash constraint and the model proposes. This is deliberately the thinnest layer in the repository. A guardrail worth having is one where swapping the model out changes nothing.

**Ledger** — `src/server/engine/ledger.ts`
Append-only, hash chained. Every record carries the hash of the one before it, so the audit trail cannot be quietly edited after the fact. The UI shows verification passing *and* deliberately tampering with a record to show it failing, because a chain nobody tests is decoration.

## The two workflows

**Kit 01, treasury.** The desk holds USD, EUR and SGD against per-currency reserve floors, with more obligations due than spendable cash. The engine converts out of surplus currencies to close gaps, funds what it can, defers what the contract allows, and refuses to defer payroll or tax at all. Anything irreversible above the auto-execute cap waits for a named human.

When a late deposit arrives, the engine compares a **capacity fingerprint** taken before the cycle. An obligation that was deferred stays deferred unless the new cash actually makes it payable. This is the Kit 01 requirement that a deposit must only reopen decisions it changes, and it is covered by tests in `tests/cycle.test.ts` in both directions: a small windfall changes nothing, a large one reopens exactly the right item.

**Kit 03, incident.** A supplier reports a payout that never landed. While the transfer is `SENT` the engine will not replace it, because in flight is not failed. Once it reaches a terminal `FAILED` with a failure type, one replacement is allowed, under a fresh `request_id`, and the second SWIFT fee is shown to the approver *before* the money moves. Reusing the original key is refused too, from the other direction: that path silently replays the original and the agent believes a second payment went out when none did.

## What this is not

It is not a payments product, and it does not route around Airwallex. It is the control layer that has to exist before an agent can be given a key at all.

The simulation is honest about what it is: a re-implementation of documented sandbox behaviour, including the parts that are traps, so the guardrail can be proven without credentials. Point it at the sandbox and the same checks run against the same calls.

Chargebacks, card issuing and agentic commerce are out of scope by choice. Those kits need acquiring and issuing entitlements that several participants report are not enabled on their sandbox accounts, and a demo that depends on someone else's approval queue is not a demo.

## Notes

- Amounts are major units throughout. `31000` is thirty one thousand dollars.
- The scenario data in `src/server/state/store.ts` is synthetic. No real company, payee or balance appears anywhere.
- Everything is in memory by design. The tamper evidence the project claims lives in the hash chain, not in a database.
- Built solo by Soumwadeep Guha.

## Security posture

`npm audit` reports no advisories in anything that ships. The runtime dependency is Next 15.5.28, which is the patched line for CVE-2025-66478.

One moderate advisory remains against `@vitest/mocker`, which is a dev-only test dependency and is not reachable from the running app. Clearing it requires vitest 5, which cannot resolve against the current peer set. It is listed here rather than hidden.

Credentials are read from the environment and never leave the server process. The browser never sees the client id or the API key: every Airwallex call goes through a route handler. `.env.local` is git ignored, and no key belongs in an issue, a screenshot, or a chat window.

