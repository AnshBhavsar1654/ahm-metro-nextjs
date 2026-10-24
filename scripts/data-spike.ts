/**
 * Phase 1 data spike (human runner): reads the GMRC workbooks through the shared exceljs
 * parse layer and reports any drift against the committed network.json.
 *
 * The permanent check is tests/metro-data-golden.test.ts (runs on every `bun run test`);
 * this script exists for one-off runs outside vitest.
 *
 *     bun run scripts/data-spike.ts
 */
import fs from "node:fs"
import path from "node:path"
import ExcelJS from "exceljs"
import {
  LINE_SPECS,
  derivedLineStatus,
  lineStations,
  parseFareRows,
  parseLocationRows,
  readSheet,
  round,
} from "../src/domain/metro/excel-parse"

const DATA_DIR = path.join(import.meta.dirname, "..", "data")
const NETWORK = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "src", "data", "network.json"), "utf8"))

const problems: string[] = []

function compare(label: string, a: unknown, b: unknown): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    problems.push(`${label}: sheet=${JSON.stringify(a)} != network.json=${JSON.stringify(b)}`)
  }
}

async function main(): Promise<void> {
  const locationBook = new ExcelJS.Workbook()
  await locationBook.xlsx.readFile(path.join(DATA_DIR, "Location.xlsx"))
  const locationSheet = locationBook.getWorksheet(1)
  if (!locationSheet) throw new Error("Location.xlsx: no first worksheet")

  const fareBook = new ExcelJS.Workbook()
  await fareBook.xlsx.readFile(path.join(DATA_DIR, "Fare Matrix.xlsx"))
  const fareSheet = fareBook.getWorksheet(1)
  if (!fareSheet) throw new Error("Fare Matrix.xlsx: no first worksheet")

  const parsed = parseLocationRows(readSheet(locationSheet))
  const fares = parseFareRows(readSheet(fareSheet))

  const netStations = NETWORK.stations as Record<string, { lat: number; lon: number; status: string }>
  const netLines = NETWORK.lines as { id: string; stations: string[]; status: string }[]

  if (parsed.stations.size !== Object.keys(netStations).length) {
    problems.push(`station count: sheet=${parsed.stations.size} network=${Object.keys(netStations).length}`)
  }
  for (const [name, info] of parsed.stations) {
    const net = netStations[name]
    if (!net) {
      problems.push(`${name}: not in network.json`)
      continue
    }
    compare(`${name}/lat`, round(info.lat, 7), round(net.lat, 7))
    compare(`${name}/lon`, round(info.lon, 7), round(net.lon, 7))
    compare(`${name}/status`, info.status, net.status)
  }

  for (const spec of LINE_SPECS) {
    const net = netLines.find((line) => line.id === spec.id)
    if (!net) {
      problems.push(`line ${spec.id} missing in network.json`)
      continue
    }
    compare(`line ${spec.id} stations`, lineStations(spec, parsed), net.stations)
    compare(`line ${spec.id} status`, derivedLineStatus(spec, parsed), net.status)
  }

  const netFares = NETWORK.fares as Record<string, Record<string, number>>
  for (const [a, row] of Object.entries(netFares)) {
    for (const [b, fare] of Object.entries(row)) {
      if (a < b) continue // stored both directions; check one
      const hit = [`${a}|${b}`, `${b}|${a}`].some((key) => fares.get(key) === fare)
      if (!hit) problems.push(`fare ${a}<->${b}: no Rs ${fare} row for either direction in Fare Matrix.xlsx`)
    }
  }

  console.log(
    `data spike: ${parsed.stations.size} stations, ${LINE_SPECS.length} corridors, ${fares.size} fare rows. ` +
      `${problems.length} mismatches vs network.json.`,
  )
  for (const problem of problems) console.log("  MISMATCH:", problem)
  if (problems.length) process.exit(1)
}

main().catch((error) => {
  console.error("data spike failed:", error)
  process.exit(1)
})
