import { NextResponse } from "next/server";
import { store } from "@/server/state/store";
import { rebuildEngine } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { scenario?: "treasury" | "incident" };
  const scenario = body.scenario === "incident" ? "incident" : "treasury";
  store.reset(scenario);
  // A fresh engine means a fresh decision ledger, so the audit trail shown after
  // a reset is the one that belongs to the run the judge is about to watch.
  rebuildEngine();
  return NextResponse.json({ ok: true, scenario });
}
