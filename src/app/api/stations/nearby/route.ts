import { NextResponse, type NextRequest } from "next/server"
import { ValueError, getNearbyStationsData } from "@/domain/metro/locations"
import { ValidationError, errorResponse, floatParam, validationResponse } from "@/server/http"

export const dynamic = "force-dynamic"

/** GET /api/stations/nearby?lat=&lng=: the three nearest open stations, with walking (or road) distance and path. */
export async function GET(request: NextRequest) {
  let lat: number | null, lng: number | null
  try {
    lat = floatParam(request.nextUrl.searchParams, "lat")
    lng = floatParam(request.nextUrl.searchParams, "lng")
  } catch (exc) {
    if (exc instanceof ValidationError) return validationResponse(exc)
    throw exc
  }
  try {
    return NextResponse.json(await getNearbyStationsData(lat, lng))
  } catch (exc) {
    if (exc instanceof ValueError) return errorResponse(exc.message)
    console.log(`[ERROR /api/stations/nearby] ${exc instanceof Error ? exc.message : String(exc)}`)
    return errorResponse("Failed to find nearby stations", 500)
  }
}
