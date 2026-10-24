import { NextResponse } from "next/server"
import { getLineGeometries } from "@/domain/metro/network"

/** GET /api/lines: each line with its stations and track geometry ([lat, lng] points, first station to last). */
export function GET() {
  return NextResponse.json(getLineGeometries())
}
