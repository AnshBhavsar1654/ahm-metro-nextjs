/**
 * The metro endpoints' payloads, exactly as backend/app.py's handlers built them. The route handlers in
 * src/app/api wrap these in HTTP; the golden tests call them directly, so the parity checks cover the
 * code the endpoints run. A result with `error` is a 400.
 */
import {
  calculateRouteDetails,
  getAllStations,
  getFare,
  isOperational,
  resolveStation,
  stationStatus,
  UNDER_CONSTRUCTION,
} from "@/domain/metro/network"
import {
  departures,
  istNow,
  journeyMinutes,
  journeyTrains,
  stayOnTrain,
  throughService,
  type StationTime,
} from "@/domain/metro/timetable"

export type ApiError = { error: string }

export const isError = (result: unknown): result is ApiError =>
  typeof result === "object" && result !== null && !Array.isArray(result) && "error" in result

/** POST /api/route */
export function routePayload(source: string, destination: string, now: StationTime = istNow()) {
  if (!source.trim() || !destination.trim()) return { error: "Missing source or destination" }

  const result = calculateRouteDetails(source, destination)
  if (result.error) return { error: result.error }
  const stays = [...stayOnTrain(result.legs), false]
  return {
    route: result.route,
    interchanges: result.interchanges,
    distance: result.distance,
    instructions: result.instructions,
    geometry: result.geometry, // along the track, for drawing the journey
    legs: result.legs.map((leg, i) => ({ ...leg, stay_on_train: stays[i] })),
    duration_minutes: journeyMinutes(result.legs),
    through_service: throughService(result.legs),
    next_trains: journeyTrains(result.legs, now),
    // Stations on the route that aren't open yet, with their status (the planner flags them; no fare then).
    not_operational: result.not_operational,
    // Other reasonable routes when the network offers more than one (quickest first). Same fare: GMRC
    // charges by origin and destination.
    alternatives: (result.alternatives ?? []).map((alt) => ({
      route: alt.route,
      legs: alt.legs,
      interchanges: alt.interchanges,
      distance: alt.distance,
      duration_minutes: journeyMinutes(alt.legs),
    })),
  }
}

/** POST /api/fare */
export function farePayload(source: string, destination: string): ApiError | { fare: number | null } {
  const [src, dst] = [resolveStation(source), resolveStation(destination)]
  if (!src || !dst) return { error: "Unknown source or destination station" }
  for (const name of [src, dst]) {
    if (stationStatus(name) === UNDER_CONSTRUCTION) return { error: `${name} station is under construction and not open yet` }
  }
  return { fare: getFare(src, dst) } // null when a station is work in progress
}

/** GET /api/fares/from: fare from one station to every other station, for the station panel's fare table. */
export function faresFrom(station: string): ApiError | { station: string; fare: number | null }[] {
  const source = resolveStation(station)
  if (!source) return { error: "Unknown station" }
  if (!isOperational(source)) return []
  return getAllStations()
    .filter((s) => s !== source)
    .map((s) => ({ station: s, fare: getFare(source, s) }))
}

/** GET /api/departures: next timetabled trains. `directions` is empty for stations the timetable doesn't cover. */
export function stationDepartures(station: string, now: StationTime = istNow()) {
  const name = resolveStation(station)
  if (!name) return { error: "Unknown station" }
  if (!isOperational(name)) {
    // trains pass Sabarmati without stopping; new lines aren't running yet
    return { station: name, status: stationStatus(name), directions: [], source: null }
  }
  return departures(name, now) ?? { station: name, status: "operational", directions: [], source: null }
}
