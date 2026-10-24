import { NextResponse, type NextRequest } from "next/server"
import { errorResponse } from "@/server/http"
import { isError, stationDepartures } from "@/server/metro-api"

export const dynamic = "force-dynamic"

/** GET /api/departures?station=: next timetabled trains. `directions` is empty where the timetable doesn't reach. */
export function GET(request: NextRequest) {
  const result = stationDepartures(request.nextUrl.searchParams.get("station") ?? "")
  return isError(result) ? errorResponse(result.error) : NextResponse.json(result)
}
