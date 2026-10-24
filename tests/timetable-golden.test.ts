/** Golden parity: departures for every station at the fixed capture moment. */
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { getAllStations } from "@/domain/metro/network"
import { stationDepartures } from "@/server/metro-api"

const GOLDEN = path.resolve(import.meta.dirname, "fixtures", "golden")
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(GOLDEN, name), "utf8"))

/** The fixed moment the fixtures were captured at. */
const NOW = { hour: 10, minute: 30 }

describe("golden parity: timetable domain", () => {
  it("departures for every station at a fixed moment", () => {
    const golden = load("departures.json") as Record<string, unknown>
    for (const station of getAllStations()) {
      expect(stationDepartures(station, NOW), station).toEqual(golden[station])
    }
  })
})
