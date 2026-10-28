import { store } from "../src/server/state/store";
import { SimulatedGateway } from "../src/server/gateway/simulated";
import { LedgerlineEngine } from "../src/server/engine/engine";
import { planTreasury } from "../src/server/agent/planner";

async function main() {
  const engine = new LedgerlineEngine(new SimulatedGateway());
  store.reset("treasury");

  const plan = await planTreasury(engine.gateway, store.get(), engine.policy);
  console.log("signature:", plan.signature);
  console.log("pinned:", plan.pinned);
  const results = await engine.runCycle(plan.intents);

  for (const r of results) {
    console.log(
      `${r.intent.kind.padEnd(17)} ${String(r.intent.amount).padStart(9)} ${r.intent.currency.padEnd(3)} ` +
        `${(r.intent.obligationId ?? "-").padEnd(12)} -> ${r.decision.verdict.padEnd(12)} | ${r.outcome}`,
    );
  }

  console.log("\nobligations after cycle 1:");
  for (const o of store.get().obligations) {
    console.log(`  ${o.id.padEnd(14)} ${o.status.padEnd(10)} deferred=${o.deferredDays} due=${o.dueInDays}`);
  }
  console.log("\nplatform balances:", store.get().wallets[0].balances);
  console.log("subsidiary balances:", store.get().wallets[1]?.balances);
  console.log("transfers:", store.get().transfers.map((t) => `${t.obligationId}:${t.status}`));
  console.log("ledger verified:", engine.ledger.verify());

  // Cycle 2, small deposit.
  const small = store.get().obligations.filter((o) => o.status === "deferred").map((o) => o.id);
  console.log("\ndeferred after cycle 1:", small);
  await engine.gateway.deposit({ globalAccountId: "sim", amount: 200, currency: "SGD", payerName: " rounding" });
  const plan2 = await planTreasury(engine.gateway, store.get(), engine.policy, plan.signature);
  const results2 = await engine.runCycle(plan2.intents);
  console.log("cycle 2 intents:", results2.map((r) => `${r.intent.kind}:${r.intent.obligationId ?? "-"}:${r.decision.verdict}`));
  console.log("cycle 2 pinned:", plan2.pinned.map((p) => p.payee));

  // Cycle 3, large deposit.
  await engine.gateway.deposit({ globalAccountId: "sim", amount: 90000, currency: "USD", payerName: "Series B" });
  const plan3 = await planTreasury(engine.gateway, store.get(), engine.policy, plan2.signature);
  const results3 = await engine.runCycle(plan3.intents);
  console.log("\ncycle 3 intents:", results3.map((r) => `${r.intent.kind}:${r.intent.obligationId ?? "-"}:${r.decision.verdict}`));
  console.log("final obligations:", store.get().obligations.map((o) => `${o.id}:${o.status}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
