import { NextResponse, type NextRequest } from "next/server"
import { MAX_QUERY, MIN_QUERY, autocomplete, validSession } from "@/server/places"
import { clientIp, crossSite, errorResponse } from "@/server/http"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

/**
 * GET /api/places/autocomplete?q=&session=&lang=: { source: "google", suggestions: [{ id, name, address }] },
 * or { source: "fallback", reason } when the search should use Nominatim instead (see src/server/places.ts).
 */
export async function GET(request: NextRequest) {
  if (crossSite(request)) return errorResponse("Forbidden", 403)
  const params = request.nextUrl.searchParams
  const query = (params.get("q") ?? "").trim()
  const session = params.get("session") ?? ""
  if (query.length < MIN_QUERY || query.length > MAX_QUERY) return errorResponse(`q must be ${MIN_QUERY}-${MAX_QUERY} characters`)
  if (!validSession(session)) return errorResponse("session must be a UUID")
  return NextResponse.json(await autocomplete(query, session, params.get("lang") ?? "en", clientIp(request)), {
    headers: NO_STORE,
  })
}
