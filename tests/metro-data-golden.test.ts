/**
 * Phase 1 golden test: the exceljs parse layer reproduces the committed network.json.
 *
 * The comparison runs against backend/data (legacy inputs) until the data files move to
 * src/data in Phase 2; build_network.ts (Phase 4) must keep this test green.
 */
import fs from "node:fs"
import path from "node:path"
import ExcelJS from "exceljs"
import { describe, expect, it } from "vitest"
import {
  LINE_SPECS,
  derivedLineStatus,
  lineStations,
  parseFareRows,
  parseLocationRows,
  readSheet,
  round,
} from "@/domain/metro/excel-parse"

const DATA_DIR = path.resolve(import.meta.dirname, "../backend/data")
const NETWORK = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "network.json"), "utf8")) as {
  transfer_minutes: number
  stations: Record<string, { lat: number; lon: number; status: string }>
  lines: { id: string; name: string; corridor: string; status: string; stations: string[] }[]
  segments: unknown[]
  fares: Record<string, Record<string, number>>
}

async function loadWorkbooks() {
  const location = new ExcelJS.Workbook()
  await location.xlsx.readFile(path.join(DATA_DIR, "Location.xlsx"))
  const fareMatrix = new ExcelJS.Workbook()
  await fareMatrix.xlsx.readFile(path.join(DATA_DIR, "Fare Matrix.xlsx"))
  const locationSheet = location.getWorksheet(1)
  const fareSheet = fareMatrix.getWorksheet(1)
  expect(locationSheet, "Location.xlsx has a first worksheet").toBeTruthy()
  expect(fareSheet, "Fare Matrix.xlsx has a first worksheet").toBeTruthy()
  return {
    location: readSheet(locationSheet!),
    fares: readSheet(fareSheet!),
  }
}

describe("metro data golden (exceljs vs committed network.json)", () => {
  it("parses the same station set with identical coordinates and statuses", async () => {
    const { location } = await loadWorkbooks()
    const parsed = parseLocationRows(location)

    expect([...parsed.stations.keys()].sort()).toEqual(Object.keys(NETWORK.stations).sort())
    for (const [name, info] of parsed.stations) {
      const net = NETWORK.stations[name]!
      expect(round(info.lat, 7), `${name} lat`).toBe(round(net.lat, 7))
      expect(round(info.lon, 7), `${name} lon`).toBe(round(net.lon, 7))
      expect(info.status, `${name} status`).toBe(net.status)
    }
  })

  it("derives each line's stations in the app's running order", async () => {
    const { location } = await loadWorkbooks()
    const parsed = parseLocationRows(location)

    expect(new Set(parsed.corridors.keys())).toEqual(new Set(LINE_SPECS.map((spec) => spec.corridor)))
    for (const spec of LINE_SPECS) {
      const net = NETWORK.lines.find((line) => line.id === spec.id)
      expect(net, `line ${spec.id} exists`).toBeTruthy()
      expect(lineStations(spec, parsed), `${spec.name} stations`).toEqual(net!.stations)
    }
  })

  it("derives each line's open/work-in-progress status from the station statuses", async () => {
    const { location } = await loadWorkbooks()
    const parsed = parseLocationRows(location)
    for (const spec of LINE_SPECS) {
      const net = NETWORK.lines.find((line) => line.id === spec.id)!
      expect(derivedLineStatus(spec, parsed), `${spec.name} status`).toBe(net.status)
    }
  })

  it("covers every fare pair the network carries, accepting one-direction rows", async () => {
    const { fares } = await loadWorkbooks()
    const parsedFares = parseFareRows(fares)

    for (const [a, row] of Object.entries(NETWORK.fares)) {
      for (const [b, fare] of Object.entries(row)) {
        if (a < b) continue // stored both directions; check one
        const possible = [`${a}|${b}`, `${b}|${a}`]
        const hit = possible.some((key) => parsedFares.get(key) === fare)
        expect(hit, `fare ${a}<->${b} = Rs ${fare} backed by either direction in the sheet`).toBe(true)
      }
    }
  })

  it("carries the documented transfer time", () => {
    expect(NETWORK.transfer_minutes).toBe(5)
  })
})
