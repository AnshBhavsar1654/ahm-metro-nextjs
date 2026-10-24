import { NextResponse } from "next/server"
import { getAllStations } from "@/domain/metro/network"

/** GET /api/stations: every station name, alphabetical. */
export function GET() {
  return NextResponse.json(getAllStations())
}
