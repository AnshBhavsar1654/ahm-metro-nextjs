import { NextResponse } from "next/server"

/** GET /api/health — first ported endpoint (backend/app.py:health). */
export function GET() {
  return NextResponse.json({ status: "ok" })
}
