import { store } from "@/server/state/store";
import { getEngine, gatewayMode, gatewayWarning } from "@/server/runtime";
import { agentMode } from "@/server/agent/claude";

export function publicState() {
  const state = store.get();
  const engine = getEngine();
  return {
    scenario: store.scenario,
    gatewayMode: gatewayMode(),
    gatewayWarning: gatewayWarning(),
    agentMode: agentMode(),
    policy: engine.policy,
    wallets: state.wallets,
    obligations: state.obligations,
    transfers: state.transfers,
    quotes: state.quotes.map((q) => ({ id: q.id, from: q.from, to: q.to, sell: q.sell, buy: q.buy, rate: q.rate, usedCount: q.usedBy.length })),
    pending: state.pendingIntents.map((intent) => ({
      intent,
      decision: state.decisions[intent.id] ?? null,
    })),
    ledgerLength: engine.ledger.length,
  };
}
