import { AirwallexGateway } from "./gateway/airwallex";
import { SimulatedGateway } from "./gateway/simulated";
import type { MoneyGateway } from "./gateway/types";
import { LedgerlineEngine } from "./engine/engine";

/**
 * Picks the gateway from the environment and parks the engine on globalThis so
 * it survives Next.js hot reload in dev.
 *
 * LEDGERLINE_GATEWAY=sim        local simulation, no credentials, default
 * LEDGERLINE_GATEWAY=airwallex  real sandbox, needs AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY
 */
export function gatewayMode(): "sim" | "airwallex" {
  const requested = (process.env.LEDGERLINE_GATEWAY ?? "sim").toLowerCase();
  const hasCreds = Boolean(process.env.AIRWALLEX_CLIENT_ID && process.env.AIRWALLEX_API_KEY);
  return requested === "airwallex" && hasCreds ? "airwallex" : "sim";
}

export function gatewayWarning(): string | null {
  const requested = (process.env.LEDGERLINE_GATEWAY ?? "sim").toLowerCase();
  if (requested !== "airwallex") return null;
  if (process.env.AIRWALLEX_CLIENT_ID && process.env.AIRWALLEX_API_KEY) return null;
  return "LEDGERLINE_GATEWAY=airwallex but no credentials were found. Running on the local simulation.";
}

function buildGateway(): MoneyGateway {
  if (gatewayMode() === "airwallex") {
    return new AirwallexGateway(
      process.env.AIRWALLEX_CLIENT_ID as string,
      process.env.AIRWALLEX_API_KEY as string,
    );
  }
  return new SimulatedGateway();
}

const globalRuntime = globalThis as unknown as { __ledgerlineEngine?: LedgerlineEngine };

export function getEngine(): LedgerlineEngine {
  if (!globalRuntime.__ledgerlineEngine) {
    globalRuntime.__ledgerlineEngine = new LedgerlineEngine(buildGateway());
  }
  return globalRuntime.__ledgerlineEngine;
}

/** Forces a new gateway, used after credentials arrive without a restart. */
export function rebuildEngine(): LedgerlineEngine {
  globalRuntime.__ledgerlineEngine = new LedgerlineEngine(buildGateway());
  return globalRuntime.__ledgerlineEngine;
}
