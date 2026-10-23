/**
 * Nearby stations and pasted Google Maps links — the 1:1 TypeScript port of
 * backend/metro/locations.py.
 *
 * Nearby: shortlist the closest stations by straight line, then ask a routing service (walking
 * first, driving as fallback) for real distances and times, and the actual path for the three
 * nearest, so the map can draw them.
 *
 * Maps links: a pasted link often carries its coordinates; if it doesn't, follow redirects
 * (only on allowed hosts) until it does.
 */
import { NETWORK, isOperational } from "./network"
import { pyRound } from "./rounding"

/** The backend raised ValueError for anything the rider can fix; the API layer maps it to HTTP 400. */
export class ValueError extends Error {}

type Coords = [lat: number, lng: number]

export type StationWithCoords = { name: string; latitude: number; longitude: number }

export function straightLineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  /** Great-circle distance in km (only used to shortlist stations before asking for road distances). */
  const radians = (x: number) => (x * Math.PI) / 180
  const [rlat1, rlon1, rlat2, rlon2] = [radians(lat1), radians(lon1), radians(lat2), radians(lon2)]
  const a = Math.sin((rlat2 - rlat1) / 2) ** 2 + Math.cos(rlat1) * Math.cos(rlat2) * Math.sin((rlon2 - rlon1) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}

// Routing services, best first: walking routes (FOSSGIS, OpenStreetMap's German chapter), then
// driving routes (OSRM demo server) if that is down. Both are free for light use; send few
// requests and identify the app.
const ROUTERS: { kind: "walk" | "road"; base: string; profile: string }[] = [
  { kind: "walk", base: "https://routing.openstreetmap.de/routed-foot", profile: "foot" },
  { kind: "road", base: "https://router.project-osrm.org", profile: "driving" },
]
const ROUTER_HEADERS = { "User-Agent": "AhmedabadMetroApp/1.0 (nearest-station finder)" }

// Only these hosts are fetched server-side (and every redirect hop is checked against them).
const ALLOWED_MAPS_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "maps.google.com",
  "google.com",
  "www.google.com",
  "google.co.in",
  "www.google.co.in",
])
const MAX_REDIRECTS = 5
const MAPS_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; AhmedabadMetroBot/1.0)" }

const NUM = "(-?\\d+(?:\\.\\d+)?)"
// (pattern, latitude group, longitude group)
const COORD_PATTERNS: [RegExp, 1 | 2, 1 | 2][] = [
  [new RegExp(`@${NUM},${NUM}`), 1, 2],
  [new RegExp(`[?&](?:q|query|ll|center)=${NUM},${NUM}`), 1, 2],
  [new RegExp(`!3d${NUM}!4d${NUM}`), 1, 2],
  [new RegExp(`!4d${NUM}!3d${NUM}`), 2, 1],
]

/** The '?' query of a URL — Python's urlparse(url).query (fragment split first). */
function urlQuery(url: string): string {
  const hash = url.indexOf("#")
  const withoutFragment = hash === -1 ? url : url.slice(0, hash)
  const question = withoutFragment.indexOf("?")
  return question === -1 ? "" : withoutFragment.slice(question + 1)
}

/** Python's parse_qs: '+' is a space, blank values drop the pair, repeated keys collect. */
function parseQuery(queryString: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of queryString.split("&")) {
    if (!part) continue
    const eq = part.indexOf("=")
    const name = unquotePlus(eq === -1 ? part : part.slice(0, eq))
    const value = eq === -1 ? "" : part.slice(eq + 1)
    if (!value) continue
    const list = out.get(name) ?? []
    list.push(unquotePlus(value))
    out.set(name, list)
  }
  return out
}

function unquote(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text // Python replaces malformed escapes; keeping the text is close enough for Map URLs
  }
}

function unquotePlus(text: string): string {
  return unquote(text.replaceAll("+", " "))
}

export function extractCoordinatesFromUrl(url: string): Coords | null {
  const candidates: string[] = [url]
  const query = parseQuery(urlQuery(url))
  for (const key of ["q", "query", "ll", "center"]) {
    candidates.push(...(query.get(key) ?? []))
  }

  for (const candidate of candidates) {
    const text = unquote(candidate)
    for (const [pattern, latGroup, lngGroup] of COORD_PATTERNS) {
      const match = pattern.exec(text)
      if (match) {
        const lat = Number(match[latGroup])
        const lng = Number(match[lngGroup])
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return [lat, lng]
      }
    }
  }
  return null
}

function isAllowedMapsUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && ALLOWED_MAPS_HOSTS.has(parsed.hostname)
}

function urljoin(base: string, target: string): string {
  try {
    return new URL(target, base).toString()
  } catch {
    return target
  }
}

const isRedirectStatus = (status: number): boolean => [301, 302, 303, 307, 308].includes(status)

export type ResolvedMapsLocation = {
  latitude: number
  longitude: number
  resolved_url: string
  place_name: string
}

export async function resolveGoogleMapsUrl(rawUrl: string): Promise<ResolvedMapsLocation> {
  let normalized = (rawUrl ?? "").trim()
  if (!normalized) throw new ValueError("Missing Google Maps URL")
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = `https://${normalized}`
  }
  if (!isAllowedMapsUrl(normalized)) {
    throw new ValueError("Please provide a Google Maps link")
  }

  // Coordinates are often already in the pasted link; no request needed.
  let coordinates = extractCoordinatesFromUrl(normalized)
  let finalUrl = normalized

  if (!coordinates) {
    try {
      let current = normalized
      for (let hop = 0; hop < MAX_REDIRECTS + 1; hop++) {
        const response = await fetch(current, {
          redirect: "manual",
          headers: MAPS_HEADERS,
          signal: AbortSignal.timeout(10_000),
        })
        const location = response.headers.get("Location")
        if (isRedirectStatus(response.status) && location) {
          current = urljoin(current, location)
          if (!isAllowedMapsUrl(current)) {
            throw new ValueError("Please provide a Google Maps link")
          }
          coordinates = extractCoordinatesFromUrl(current)
          if (coordinates) break
          continue
        }
        if (!response.ok) throw new Error("HTTP error") // Python: raise_for_status
        break
      }
      finalUrl = current
    } catch (error) {
      if (error instanceof ValueError) throw error
      throw new ValueError("Unable to open that Google Maps link")
    }
  }

  if (!coordinates) {
    throw new ValueError("Could not extract coordinates from the provided Google Maps link")
  }

  const [latitude, longitude] = coordinates
  return { latitude, longitude, resolved_url: finalUrl, place_name: "Google Maps location" }
}

export function getStationsWithCoordinates(): StationWithCoords[] {
  /** All stations with coordinates, for mapping (one entry per station, interchanges included once). */
  return [...NETWORK.coords.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, [lat, lon]]) => ({ name, latitude: lat, longitude: lon }))
}

type NearbyStation = StationWithCoords & {
  straight?: number
  distance?: number
  distance_type?: "walk" | "road" | "straight"
  walk_minutes?: number | null
  path?: [number, number][] | null
}

/** Distances (km) and durations (min) from the user to each station, or null if the service is unavailable. */
async function table(
  base: string,
  profile: string,
  lat: number,
  lng: number,
  stations: StationWithCoords[],
): Promise<[number[], (number | null)[]] | null> {
  const coordinates = [`${lng},${lat}`, ...stations.map((s) => `${s.longitude},${s.latitude}`)].join(";")
  try {
    const params = new URLSearchParams({ sources: "0", annotations: "distance,duration" })
    const response = await fetch(`${base}/table/v1/${profile}/${coordinates}?${params}`, {
      headers: ROUTER_HEADERS,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null // Python: raise_for_status -> except -> None
    const data = (await response.json()) as {
      distances: (number | null)[][]
      durations: (number | null)[][]
    }
    const distances = data.distances[0]!.slice(1)
    const durations = data.durations[0]!.slice(1)
    if (distances.length !== stations.length || distances.some((d) => d === null || d === undefined)) return null
    return [distances.map((d) => d! / 1000), durations.map((t) => (t === null || t === undefined ? null : t / 60))]
  } catch {
    return null
  }
}

/** Path from the user to a station as [[lat, lng], ...], or None. Starts and ends exactly at the two markers. */
async function routePath(
  base: string,
  profile: string,
  lat: number,
  lng: number,
  station: StationWithCoords,
): Promise<[number, number][] | null> {
  try {
    const response = await fetch(
      `${base}/route/v1/${profile}/${lng},${lat};${station.longitude},${station.latitude}?${new URLSearchParams({
        overview: "full",
        geometries: "geojson",
      })}`,
      { headers: ROUTER_HEADERS, signal: AbortSignal.timeout(10_000) },
    )
    if (!response.ok) return null
    const data = (await response.json()) as {
      routes: { geometry: { coordinates: [lng: number, lat: number][] } }[]
    }
    const coords = data.routes[0]!.geometry.coordinates
    const path = coords.map(([pLng, pLat]) => [pyRound(pLat, 6), pyRound(pLng, 6)] as [number, number])
    return [[lat, lng], ...path, [station.latitude, station.longitude]]
  } catch {
    return null
  }
}

export async function getNearbyStationsData(lat: number | null, lng: number | null): Promise<NearbyStation[]> {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    throw new ValueError("Missing latitude/longitude parameters")
  }
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) {
    throw new ValueError("Invalid coordinates")
  }

  // Only stations a rider can use today.
  const stations: NearbyStation[] = getStationsWithCoordinates().filter((s) => isOperational(s.name))

  // Pre-select the closest candidates by straight line so the routing request stays small.
  for (const station of stations) {
    station.straight = straightLineKm(lat, lng, station.latitude, station.longitude)
  }
  const candidates = stations
    .slice()
    .sort((a, b) => a.straight! - b.straight!)
    .slice(0, 8)

  // Walking distance and time from the first routing service that answers; a straight line if none does.
  let router: { kind: "walk" | "road"; base: string; profile: string } | null = null
  for (const option of ROUTERS) {
    const result = await table(option.base, option.profile, lat, lng, candidates)
    if (result) {
      router = option
      const [distances, minuteOptions] = result
      candidates.forEach((station, i) => {
        const minutes = minuteOptions[i] ?? null
        station.distance = pyRound(distances[i]!, 1)
        station.distance_type = option.kind
        station.walk_minutes = option.kind === "walk" && minutes !== null ? pyRound(minutes) : null
      })
      break
    }
  }
  for (const station of candidates) {
    if (!router) {
      station.distance = pyRound(station.straight!, 1)
      station.distance_type = "straight"
      station.walk_minutes = null
    }
    delete station.straight
  }
  const nearest = candidates
    .slice()
    .sort((a, b) => a.distance! - b.distance!)
    .slice(0, 3)

  // The path to each of the three, from the same service, fetched together. Without one the map
  // draws a straight line.
  let paths: ([number, number][] | null)[] = nearest.map(() => null)
  if (router) {
    paths = await Promise.all(nearest.map((station) => routePath(router!.base, router!.profile, lat, lng, station)))
  }
  nearest.forEach((station, i) => {
    station.path = paths[i]!
  })
  return nearest
}

export const resolveGoogleMapsLocationData = resolveGoogleMapsUrl
