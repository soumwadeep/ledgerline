import { NextResponse } from "next/server";
import { publicState } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(publicState());
}
