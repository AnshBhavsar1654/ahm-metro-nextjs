import { NextResponse } from "next/server"
import { ValueError, resolveGoogleMapsLocationData } from "@/domain/metro/locations"
import { ValidationError, errorResponse, jsonBody, stringField, validationResponse } from "@/server/http"

/** POST /api/location/resolve-google-maps { url }: the place a pasted Google Maps link points at. */
export async function POST(request: Request) {
  let url: string
  try {
    url = stringField(await jsonBody(request), "url")
  } catch (exc) {
    if (exc instanceof ValidationError) return validationResponse(exc)
    throw exc
  }
  try {
    return NextResponse.json(await resolveGoogleMapsLocationData(url))
  } catch (exc) {
    if (exc instanceof ValueError) return errorResponse(exc.message)
    console.log(`[ERROR /api/location/resolve-google-maps] ${exc instanceof Error ? exc.message : String(exc)}`)
    return errorResponse("Failed to resolve Google Maps link", 500)
  }
}
