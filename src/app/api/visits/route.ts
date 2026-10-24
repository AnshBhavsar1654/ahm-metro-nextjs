import { NextResponse } from "next/server"
import { clientIp } from "@/server/http"
import { counter } from "@/server/visits"

export const dynamic = "force-dynamic"

/** GET /api/visits: { total, online } */
export async function GET() {
  return NextResponse.json(await counter().snapshot())
}

/** POST /api/visits: the browser calls this once per day; the footer then follows /api/visits/stream. */
export async function POST(request: Request) {
  return NextResponse.json(await counter().record(clientIp(request)))
}
