import { NextResponse } from "next/server";
import { getEngine } from "@/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const engine = getEngine();
  const records = engine.ledger.all();
  const verification = engine.ledger.verify();
  const tampered = engine.ledger.tamperedCopy("amount").verify();

  return NextResponse.json({
    records,
    verification,
    // Proof the chain is load bearing: mutate one payload and show that
    // verification now fails and reports where.
    tamperProof: tampered,
  });
}
