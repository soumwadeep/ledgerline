import { NextResponse } from "next/server";
import { store } from "@/server/state/store";
import { getEngine } from "@/server/runtime";
import { propose } from "@/server/agent/claude";
import { cashSignature, planIncident } from "@/server/agent/planner";

export const dynamic = "force-dynamic";

/**
 * Runs one decision cycle.
 *
 * body: { scenario: "treasury" | "incident", reopenOnly?: string }
 *
 * `reopenOnly` is the previous cycle's cash fingerprint. Passing it makes the
 * planner re-open only the obligations whose currency actually gained capacity,
 * which is the behaviour Kit 01 asks for.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    scenario?: "treasury" | "incident";
    reopenOnly?: string;
  };

  const engine = getEngine();
  const state = store.get();
  const scenario = body.scenario ?? store.scenario;

  let intents;
  let source: "claude" | "deterministic" | "incident_planner";
  let notes: string[] = [];
  let signature: string;

  if (scenario === "incident") {
    intents = planIncident(state);
    source = "incident_planner";
    signature = cashSignature(state, engine.policy);
  } else {
    const proposed = await propose(body.reopenOnly);
    intents = proposed.intents;
    source = proposed.source;
    notes = proposed.notes;
    signature = proposed.signature;
  }

  state.pendingIntents = intents;
  const results = await engine.runCycle(intents);

  const escalated = intents.filter((i) => state.decisions[i.id]?.verdict === "escalate");
  state.pendingIntents = escalated;

  return NextResponse.json({
    source,
    notes,
    signature,
    results: results.map((r) => ({
      intent: r.intent,
      decision: r.decision,
      outcome: r.outcome,
    })),
  });
}
