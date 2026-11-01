/**
 * Google Places (New) for the Nearest Stations place search, and nothing else: Autocomplete for the
 * suggestions, then Place Details (location only) for the one the user picks. MAPS_API_KEY never leaves
 * the server.
 *
 * Google's free monthly usage per SKU (developers.google.com/maps/billing-and-pricing/pricing):
 *   - Autocomplete Requests: 10,000. Every Autocomplete (New) call counts; a session that ends in Place
 *     Details Essentials only stops counting after 12 calls.
 *   - Place Details Essentials (the `location` field): 10,000.
 * So that the free usage is never used up, each SKU stops at MONTHLY_BUDGET (80% of it) for the rest of the
 * calendar month (Pacific time, as Google bills). The search then falls back to OpenStreetMap Nominatim, as it
 * did before.
 *
 * Every call is checked against, in order: a per-IP limit per minute and per day, a global per-minute limit
 * and a global daily cap (so a burst or a script can't spend the month in a day), then the monthly budget.
 * The counters live in the shared store. Google is used only with Redis behind it, because a counter kept in
 * the process would start again from zero on every restart or deploy. If Redis is unreachable, the search
 * falls back rather than calling Google without counting.
 *
 * Place Details only accepts a place ID that this server's autocomplete just returned for the same session
 * token, so the details endpoint can't be used as a free geocoder for any place ID.
 */
import { store } from "./store"

export const FREE_PER_MONTH = 10_000
export const MONTHLY_BUDGET = Math.floor(FREE_PER_MONTH * 0.8)

type Sku = "autocomplete" | "details"

/** Per SKU: per client IP (minute, day), all clients (minute, day). */
export const LIMITS: Record<Sku, { ipMinute: number; ipDay: number; globalMinute: number; globalDay: number }> = {
  autocomplete: { ipMinute: 30, ipDay: 200, globalMinute: 60, globalDay: 400 },
  details: { ipMinute: 10, ipDay: 50, globalMinute: 30, globalDay: 400 },
}

/** An env override may only lower a limit, never raise it. */
const lowered = (name: string, fallback: number): number => {
  const value = Number.parseInt(process.env[name] ?? "", 10)
  return value > 0 ? Math.min(value, fallback) : fallback
}
export const monthlyBudget = (): number => lowered("PLACES_MONTHLY_BUDGET", MONTHLY_BUDGET)

// The area searched: Ahmedabad and Gandhinagar, with GIFT City.
const AREA = { low: { latitude: 22.85, longitude: 72.4 }, high: { latitude: 23.35, longitude: 72.8 } }

const LANGUAGES = new Set(["en", "hi", "gu"])
const TIMEOUT_MS = 4000
const SESSION_TTL = 10 * 60 // seconds an autocomplete session stays valid for picking a suggestion
const LOCATION_TTL = 30 * 24 * 3600 // Google allows caching coordinates for 30 days

export const MIN_QUERY = 3
export const MAX_QUERY = 100
const SESSION_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/

export const validSession = (token: string): boolean => SESSION_TOKEN.test(token)
export const validPlaceId = (id: string): boolean => PLACE_ID.test(id)

export type Suggestion = { id: string; name: string; address: string }
export type Fallback = { source: "fallback"; reason: "disabled" | "limited" | "budget" | "error" }

const apiKey = (): string => process.env.MAPS_API_KEY ?? ""

/** Whether Google can be used at all: a key, and counters that survive restarts. */
export function enabled(): boolean {
  return Boolean(apiKey()) && (store().kind === "redis" || process.env.PLACES_ALLOW_MEMORY_STORE === "1")
}

/** "2026-11" for the month Google bills in (Pacific time); "2026-11-01" for the day. */
export function billingPeriod(now: Date = new Date()): { month: string; day: string } {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
  return { month: day.slice(0, 7), day }
}

/** How much of this month's budget each SKU has used. */
export async function usage(): Promise<Record<Sku, { used: number; budget: number }>> {
  const { month } = billingPeriod()
  const [autocomplete, details] = await store().getMany<number>([
    `places:month:${month}:autocomplete`,
    `places:month:${month}:details`,
  ])
  const budget = monthlyBudget()
  return { autocomplete: { used: Number(autocomplete ?? 0), budget }, details: { used: Number(details ?? 0), budget } }
}

/**
 * Takes one call from every limit, or says which one is spent. The monthly counter is only taken once
 * everything else passed, so it counts calls actually made to Google.
 */
async function allow(sku: Sku, ip: string): Promise<true | Fallback> {
  const s = store()
  const limits = LIMITS[sku]
  if (!(await s.hit(`places:${sku}:ip:${ip}`, 60, limits.ipMinute))) return { source: "fallback", reason: "limited" }
  if (!(await s.hit(`places:${sku}:ip-day:${ip}`, 24 * 3600, limits.ipDay))) return { source: "fallback", reason: "limited" }
  if (!(await s.hit(`places:${sku}:all`, 60, limits.globalMinute))) return { source: "fallback", reason: "limited" }

  const { month, day } = billingPeriod()
  const today = await s.incr(`places:day:${day}:${sku}`, 2 * 24 * 3600)
  if (today === null) return { source: "fallback", reason: "error" } // store unreachable: don't call uncounted
  if (today > lowered(`PLACES_DAILY_CAP`, limits.globalDay)) return { source: "fallback", reason: "budget" }

  const used = await s.incr(`places:month:${month}:${sku}`, 40 * 24 * 3600)
  if (used === null) return { source: "fallback", reason: "error" }
  if (used > monthlyBudget()) {
    if (used === monthlyBudget() + 1)
      console.log(`[places] ${sku}: monthly budget of ${monthlyBudget()} reached for ${month}; using the fallback`)
    return { source: "fallback", reason: "budget" }
  }
  return true
}

async function google(url: string, fieldMask: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey(), "X-Goog-FieldMask": fieldMask },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return response.json()
}

type AutocompleteResponse = {
  suggestions?: {
    placePrediction?: {
      placeId?: string
      text?: { text?: string }
      structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } }
    }
  }[]
}

/** Up to five places in the Ahmedabad area matching `query`, or a fallback. */
export async function autocomplete(
  query: string,
  session: string,
  lang: string,
  ip: string,
): Promise<{ source: "google"; suggestions: Suggestion[] } | Fallback> {
  if (!enabled()) return { source: "fallback", reason: "disabled" }
  const allowed = await allow("autocomplete", ip)
  if (allowed !== true) return allowed

  let data: AutocompleteResponse
  try {
    data = (await google(
      "https://places.googleapis.com/v1/places:autocomplete",
      "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat",
      {
        method: "POST",
        body: JSON.stringify({
          input: query,
          sessionToken: session,
          languageCode: LANGUAGES.has(lang) ? lang : "en",
          includedRegionCodes: ["in"],
          locationRestriction: { rectangle: AREA },
        }),
      },
    )) as AutocompleteResponse
  } catch (exc) {
    console.log(`[places] autocomplete failed: ${exc instanceof Error ? exc.message : String(exc)}`)
    return { source: "fallback", reason: "error" }
  }

  const suggestions = (data.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => Boolean(p?.placeId && validPlaceId(p.placeId)))
    .slice(0, 5)
    .map((p) => ({
      id: p.placeId!,
      name: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
      address: p.text?.text ?? p.structuredFormat?.mainText?.text ?? "",
    }))
  await store().set(
    `places:session:${session}`,
    suggestions.map((s) => s.id),
    SESSION_TTL,
  )
  return { source: "google", suggestions }
}

/**
 * The coordinates of a place the user picked from this session's suggestions. null: the place wasn't
 * offered in this session. A Fallback: the place can't be looked up now (the client then searches
 * Nominatim for its name).
 */
export async function placeLocation(
  id: string,
  session: string,
  ip: string,
): Promise<{ latitude: number; longitude: number } | Fallback | null> {
  if (!enabled()) return { source: "fallback", reason: "disabled" }
  const s = store()
  const offered = await s.get<string[]>(`places:session:${session}`)
  if (!Array.isArray(offered) || !offered.includes(id)) return null

  const cached = await s.get<{ latitude: number; longitude: number }>(`places:loc:${id}`)
  if (cached) {
    await s.del(`places:session:${session}`)
    return cached
  }

  const allowed = await allow("details", ip)
  if (allowed !== true) return allowed

  try {
    const data = (await google(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?sessionToken=${encodeURIComponent(session)}`,
      "location",
    )) as { location?: { latitude?: unknown; longitude?: unknown } }
    const { latitude, longitude } = data.location ?? {}
    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    )
      throw new Error("no location in the response")
    const location = { latitude, longitude }
    await s.del(`places:session:${session}`) // a session ends with its details call
    await s.set(`places:loc:${id}`, location, LOCATION_TTL)
    return location
  } catch (exc) {
    console.log(`[places] details failed: ${exc instanceof Error ? exc.message : String(exc)}`)
    return { source: "fallback", reason: "error" }
  }
}
