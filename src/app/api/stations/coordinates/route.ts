import { NextResponse } from "next/server"
import { getStationsWithCoordinates } from "@/domain/metro/locations"

/** GET /api/stations/coordinates: every station with its latitude and longitude (interchanges once). */
export function GET() {
  return NextResponse.json(getStationsWithCoordinates())
}
