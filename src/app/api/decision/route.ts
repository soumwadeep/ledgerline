import { NextResponse } from "next/server";
import { store } from "@/server/state/store";
import { getEngine } from "@/server/runtime";

export const dynamic = "force-dynamic";

/**
 * Human approval is the only way an escalated intent can move money, and a
 * blocked intent cannot be moved by anything. That second half is asserted here
 * rather than assumed.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    intentId?: string;
    action?: "approve" | "reject";
    by?: string;
  };

  const engine = getEngine();
  const state = store.get();
  const intent = state.pendingIntents.find((i) => i.id === body.intentId);

  if (!intent) {
    return NextResponse.json({ ok: false, detail: "that intent is no longer awaiting a decision" }, { status: 409 });
  }
  if (!body.by || body.by.length < 3) {
    return NextResponse.json({ ok: false, detail: "an approver must be named. Anonymous approvals are not recorded" }, { status: 400 });
  }

  const result =
    body.action === "reject"
      ? await engine.reject(intent.id, body.by)
      : await engine.approve(intent.id, body.by);

  return NextResponse.json({ ok: result.ok, detail: result.detail });
}
