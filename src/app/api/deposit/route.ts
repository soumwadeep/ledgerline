import { NextResponse } from "next/server";
import { getEngine } from "@/server/runtime";

export const dynamic = "force-dynamic";

/**
 * Simulates the late deposit arriving. Kit 01 asks what happens to decisions
 * already taken once new cash shows up, and this is the event that triggers it.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    currency?: string;
    amount?: number;
    payerName?: string;
  };

  const currency = (body.currency ?? "USD").toUpperCase();
  const amount = Number(body.amount ?? 20000);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ ok: false, detail: "amount must be a positive number in major units" }, { status: 400 });
  }

  const engine = getEngine();
  // Ask the gateway for an account that can receive this currency rather than
  // requiring a hand configured id. On the live sandbox that creates one if the
  // desk does not already have it.
  const { id: accountId, note } = await engine.gateway.ensureGlobalAccount(currency);

  try {
    const result = await engine.gateway.deposit({
      globalAccountId: accountId,
      amount,
      currency,
      payerName: body.payerName ?? "Customer settlement",
    });
    engine.ledger.append("deposit", { currency, amount, payerName: body.payerName ?? "Customer settlement", accountId, ...result });
    return NextResponse.json({ ok: true, detail: `${note}. ${result.note}`, currency, amount });
  } catch (error) {
    return NextResponse.json({ ok: false, detail: error instanceof Error ? error.message : "deposit failed" }, { status: 502 });
  }
}
