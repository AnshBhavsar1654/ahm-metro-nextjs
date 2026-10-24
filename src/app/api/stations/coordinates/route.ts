import { NextResponse } from "next/server"
import { getStationsWithCoordinates } from "@/domain/metro/locations"

/** GET /api/stations/coordinates */
export function GET() {
  return NextResponse.json(getStationsWithCoordinates())
}
