import { NextResponse } from "next/server";
import { runTrapLab } from "@/server/traps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const traps = await runTrapLab();
    return NextResponse.json({ ok: true, traps });
  } catch (error) {
    return NextResponse.json(
      { ok: false, detail: error instanceof Error ? error.message : "trap lab failed" },
      { status: 500 },
    );
  }
}
