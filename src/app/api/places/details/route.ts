import { NextResponse, type NextRequest } from "next/server"
import { placeLocation, validPlaceId, validSession } from "@/server/places"
import { clientIp, crossSite, errorResponse } from "@/server/http"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * GET /api/places/details?id=&session=: { latitude, longitude } of a place the autocomplete offered in this
 * session; 404 if it didn't; { source: "fallback", reason } if it can't be looked up now.
 */
export async function GET(request: NextRequest) {
  if (crossSite(request)) return errorResponse("Forbidden", 403)
  const params = request.nextUrl.searchParams
  const id = params.get("id") ?? ""
  const session = params.get("session") ?? ""
  if (!validPlaceId(id) || !validSession(session)) return errorResponse("Invalid id or session")
  const location = await placeLocation(id, session, clientIp(request))
  if (!location) return errorResponse("Unknown place for this session", 404)
  return NextResponse.json(location, { headers: NO_STORE })
}
