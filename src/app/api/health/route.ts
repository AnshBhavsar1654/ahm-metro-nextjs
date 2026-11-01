import { NextResponse } from "next/server"

/** GET /api/health: { status: "ok" }. Used for uptime checks and by the chat widget to wake the server. */
export function GET() {
  return NextResponse.json({ status: "ok" })
}
