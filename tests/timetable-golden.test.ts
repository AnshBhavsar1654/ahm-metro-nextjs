/** Golden parity: departures for every station at the fixed capture moment. */
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { getAllStations, isOperational, resolveStation, stationStatus } from "@/domain/metro/network"
import { departures } from "@/domain/metro/timetable"

const GOLDEN = path.resolve(import.meta.dirname, "fixtures", "golden")
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(GOLDEN, name), "utf8"))

/** The fixed moment the fixtures were captured at. */
const NOW = { hour: 10, minute: 30 }

/** Exactly backend/app.py's station_departures(). */
function stationDepartures(station: string) {
  const name = resolveStation(station)
  if (!name) return { error: "Unknown station" }
  if (!isOperational(name)) {
    return { station: name, status: stationStatus(name), directions: [], source: null }
  }
  return departures(name, NOW) ?? { station: name, status: "operational", directions: [], source: null }
}

describe("golden parity: timetable domain", () => {
  it("departures for every station at a fixed moment", () => {
    const golden = load("departures.json") as Record<string, unknown>
    for (const station of getAllStations()) {
      expect(stationDepartures(station), station).toEqual(golden[station])
    }
  })
})
