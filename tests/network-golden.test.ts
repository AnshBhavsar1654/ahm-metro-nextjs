/**
 * Golden parity: the TypeScript domain against the real outputs of the frozen FastAPI backend
 * (captured by scripts/capture-golden.py from the actual Python code).
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  calculateRouteDetails,
  getAllStations,
  getFare,
  getLineGeometries,
  isOperational,
  resolveStation,
} from "@/domain/metro/network"
import { journeyMinutes, journeyTrains, stayOnTrain, throughService } from "@/domain/metro/timetable"

const GOLDEN = path.resolve(import.meta.dirname, "fixtures", "golden")
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(GOLDEN, name), "utf8"))

/** The fixed moment the fixtures were captured at (a Wednesday, metro running). */
const NOW = { hour: 10, minute: 30 }

/** Exactly the dict backend/app.py's /api/route handler builds (minus the HTTP wrapper). */
function routePayload(source: string, destination: string) {
  const result = calculateRouteDetails(source, destination)
  if (result.error) return { error: result.error }
  const stays = [...stayOnTrain(result.legs), false]
  return {
    route: result.route,
    interchanges: result.interchanges,
    distance: result.distance,
    instructions: result.instructions,
    geometry: result.geometry,
    legs: result.legs.map((leg, i) => ({ ...leg, stay_on_train: stays[i] })),
    duration_minutes: journeyMinutes(result.legs),
    through_service: throughService(result.legs),
    next_trains: journeyTrains(result.legs, NOW),
    not_operational: result.not_operational,
    alternatives: (result.alternatives ?? []).map((alt) => ({
      route: alt.route,
      legs: alt.legs,
      interchanges: alt.interchanges,
      distance: alt.distance,
      duration_minutes: journeyMinutes(alt.legs),
    })),
  }
}

/** Exactly backend/app.py's fares_from(). */
function faresFrom(source: string) {
  const resolved = resolveStation(source)
  if (!resolved) return { error: "Unknown station" }
  if (!isOperational(resolved)) return []
  return getAllStations()
    .filter((s) => s !== resolved)
    .map((s) => ({ station: s, fare: getFare(resolved, s) }))
}

describe("golden parity: network domain", () => {
  it("stations list (alphabetical)", () => {
    expect(getAllStations()).toEqual(load("stations.json"))
  })

  it("line geometries", () => {
    expect(getLineGeometries()).toEqual(load("lines.json"))
  })

  it("domain error payloads", () => {
    const errors = load("route-errors.json") as Record<string, { error: string }>
    expect(routePayload("Nope Station", "APMC")).toEqual(errors["unknown-source"])
    expect(routePayload("APMC", "Nope Station")).toEqual(errors["unknown-destination"])
    expect(routePayload("APMC", "APMC")).toEqual(errors["same-station"])
  })

  it("fares from every station", () => {
    const golden = load("fares.json") as Record<string, unknown>
    for (const station of getAllStations()) {
      expect(faresFrom(station), station).toEqual(golden[station])
    }
  })

  it(
    "every ordered pair of distinct stations, field for field (route, legs, geometry, minutes, next trains, alternatives)",
    { timeout: 15 * 60_000 },
    () => {
      const golden = load("routes.json") as Record<string, unknown>
      const stations = getAllStations()
      const actual = new Map<string, unknown>()
      for (const src of stations) {
        for (const dst of stations) {
          if (src !== dst) actual.set(`${src}|${dst}`, routePayload(src, dst))
        }
      }
      expect(actual.size).toBe(62 * 61)
      expect(Object.keys(golden)).toHaveLength(actual.size)
      for (const [pair, expected] of Object.entries(golden)) {
        expect(actual.get(pair), pair).toEqual(expected)
      }
    },
  )
})
