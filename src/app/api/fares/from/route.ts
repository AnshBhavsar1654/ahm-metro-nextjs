import { NextResponse, type NextRequest } from "next/server"
import { errorResponse } from "@/server/http"
import { faresFrom, isError } from "@/server/metro-api"

/** GET /api/fares/from?station=: fare from one station to every other, for the station panel's fare table. */
export function GET(request: NextRequest) {
  const result = faresFrom(request.nextUrl.searchParams.get("station") ?? "")
  return isError(result) ? errorResponse(result.error) : NextResponse.json(result)
}
