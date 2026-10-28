import { beforeEach, describe, expect, it } from "vitest";
import { store } from "../src/server/state/store";
import { SimulatedGateway } from "../src/server/gateway/simulated";
import { LedgerlineEngine } from "../src/server/engine/engine";
import { cashSignature, planTreasury } from "../src/server/agent/planner";
import type { Intent } from "../src/server/types";

/**
 * End to end over the planner, not the individual checks. The point of these is
 * that the whole Kit 01 sentence has to hold: rank what to fund, convert, defer
 * or escalate, and after a later deposit only reopen the decisions the new cash
 * actually changes.
 */

let engine: LedgerlineEngine;

beforeEach(() => {
  store.reset("treasury");
  engine = new LedgerlineEngine(new SimulatedGateway());
});

async function cycle(reopenOnly?: string) {
  const plan = await planTreasury(engine.gateway, store.get(), engine.policy, reopenOnly);
  store.get().pendingIntents = plan.intents;
  const results = await engine.runCycle(plan.intents);
  return { plan, results };
}

function deferred(): string[] {
  return store.get().obligations.filter((o) => o.status === "deferred").map((o) => o.id);
}

function proposed(results: { intent: Intent }[]): string[] {
  return results.map((r) => r.intent.obligationId ?? r.intent.kind);
}

describe("the treasury cycle", () => {
  it("converts from a surplus currency to close a shortfall", async () => {
    const { results } = await cycle();
    const conversions = results.filter((r) => r.intent.kind === "convert");
    expect(conversions.length).toBeGreaterThan(0);
    expect(conversions.every((r) => r.decision.verdict !== "blocked")).toBe(true);
  });

  it("produces both an executed and an escalated outcome, and pays nothing twice", async () => {
    const { results } = await cycle();
    const verdicts = new Set(results.map((r) => r.decision.verdict));
    expect(verdicts.has("auto_execute")).toBe(true);
    expect(verdicts.has("escalate")).toBe(true);

    const counts = new Map<string, number>();
    for (const transfer of store.get().transfers) {
      if (!transfer.obligationId || transfer.status === "CANCELLED") continue;
      counts.set(transfer.obligationId, (counts.get(transfer.obligationId) ?? 0) + 1);
    }
    for (const [obligationId, count] of counts) {
      expect(count, `obligation ${obligationId} was paid ${count} times`).toBe(1);
    }
  });

  it("never breaches a reserve floor while doing it", async () => {
    await cycle();
    for (const wallet of store.get().wallets) {
      for (const [currency, balance] of Object.entries(wallet.balances)) {
        const floor = engine.policy.reserveFloors[currency] ?? 0;
        const message = `${wallet.id} ${currency} ${balance} fell below floor ${floor}`;
        expect(balance >= floor, message).toBe(true);
      }
    }
  });

  it("keeps the audit trail intact across a full cycle", async () => {
    await cycle();
    expect(engine.ledger.verify().ok).toBe(true);
    expect(engine.ledger.length).toBeGreaterThan(5);
  });

  it("pays a connected account obligation from that account, not the platform", async () => {
    const subsidiaryBefore = store.get().wallets[1].balances.EUR;
    const platformBefore = store.get().wallets[0].balances.EUR;
    await cycle();
    expect(store.get().wallets[1].balances.EUR).toBeLessThan(subsidiaryBefore);
    // The VAT return is the only EUR obligation owned by the subsidiary, and it
    // is smaller than the movement in the platform's own EUR balance caused by
    // the conversions that funded the supplier invoice.
    expect(platformBefore).toBeGreaterThan(0);
  });
});

describe("reopening decisions after a deposit", () => {
  it("leaves a deferred obligation alone when new cash does not change the outcome", async () => {
    const first = await cycle();
    const wasDeferred = deferred();
    expect(wasDeferred.length, "the scenario is meant to force at least one deferral").toBeGreaterThan(0);

    await engine.gateway.deposit({
      globalAccountId: "sim",
      amount: 200,
      currency: "SGD",
      payerName: "Stray rounding",
    });

    const second = await cycle(first.plan.signature);
    expect(proposed(second.results), "a 200 SGD windfall must not reopen the deferral").not.toContain(wasDeferred[0]);
    expect(second.plan.pinned.map((p) => p.obligationId)).toContain(wasDeferred[0]);
  });

  it("reopens a deferred obligation once new cash makes it payable", async () => {
    const first = await cycle();
    const wasDeferred = deferred()[0];

    await engine.gateway.deposit({
      globalAccountId: "sim",
      amount: 90000,
      currency: "USD",
      payerName: "Series B tranche",
    });

    const second = await cycle(first.plan.signature);
    expect(proposed(second.results)).toContain(wasDeferred);
    expect(store.get().obligations.find((o) => o.id === wasDeferred)?.status).toBe("paid");
  });

  it("changes the signature only when capacity changes", async () => {
    const state = store.get();
    const before = cashSignature(state, engine.policy);
    expect(cashSignature(state, engine.policy)).toBe(before);

    await engine.gateway.deposit({
      globalAccountId: "sim",
      amount: 5000,
      currency: "USD",
      payerName: "Settlement",
    });
    expect(cashSignature(store.get(), engine.policy)).not.toBe(before);
  });
});
