/**
 * Phase 1 data spike: proves exceljs can read the GMRC workbooks and that a TypeScript
 * port of build_network.py's parsing reproduces the committed network.json.
 *
 * Runs against backend/data (legacy inputs). When build_network.ts is finalised
 * (Phase 4) this comparison becomes its permanent golden test.
 *
 *     bun run scripts/data-spike.ts
 */
import fs from "node:fs"
import path from "node:path"
import ExcelJS from "exceljs"

const DATA_DIR = path.join(import.meta.dirname, "..", "backend", "data")
const NETWORK = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "network.json"), "utf8"))

// Same corridor table as build_network.py (order = the sheet's listing order vs the app's).
const LINES = [
  { id: "red", name: "Red Line", corridor: "North South Corridor", order: "as listed" },
  { id: "blue", name: "Blue Line", corridor: "East West Corridor", order: "reversed" },
  { id: "yellow", name: "Yellow Line", corridor: "Corridor-1", order: "as listed" },
  { id: "violet", name: "Violet Line", corridor: "Corridor-2", order: "as listed" },
  { id: "pink", name: "Pink Line", corridor: "Airport Corridor", order: "as listed" },
  { id: "lightblue", name: "Light Blue Line", corridor: "GIFT City Extension", order: "as listed" },
]

type Cell = string | number | boolean | null | undefined
type Row = Record<string, Cell>

const problems: string[] = []
const stats = { stations: 0, corridors: 0, fares: 0 }

function head(c: Cell): string {
  return String(c ?? "").trim()
}

/** Reads a sheet into rows keyed by trimmed header text (the whole df.read_excel contract, incl. trims). */
function readSheet(workbook: ExcelJS.Workbook, file: string): Row[] {
  const sheet = workbook.getWorksheet(1)
  if (!sheet) throw new Error(`${file}: no first worksheet`)
  const rows: Row[] = []
  let headers: string[] | null = null
  sheet.eachRow((row) => {
    const values = (row.values as unknown[]) ?? []
    const cells: string[] = values.slice(1).map((v) => head(v as Cell))
    if (headers === null) {
      headers = cells
      return
    }
    const record: Row = {}
    headers.forEach((h, i) => (record[h] = values[i + 1] as Cell))
    rows.push(record)
  })
  return rows
}

/** exceljs hands over rich-text/formula objects pandas never sees; the port must stringify the way pandas does. */
function text(value: Cell): string {
  if (value == null) return ""
  if (typeof value === "string") return value.trim()
  if (typeof value === "object") {
    const rich = value as { result?: Cell; richText?: [{ text: string }]; text?: string }
    if (Array.isArray(rich.richText))
      return rich.richText
        .map((part) => part.text)
        .join("")
        .trim()
    if ("result" in rich && rich.result != null) return text(rich.result)
    if ("text" in rich && typeof rich.text === "string") return rich.text.trim()
    return JSON.stringify(value)
  }
  return String(value).trim()
}

/** float(row.Latitude) — the one coercion every numeric column gets. */
function num(value: Cell): number {
  return Number(text(value))
}

function compare(label: string, a: unknown, b: unknown): void {
  const same = JSON.stringify(a) === JSON.stringify(b)
  if (!same) problems.push(`${label}: excel=${JSON.stringify(a)} != network.json=${JSON.stringify(b)}`)
}

async function main(): Promise<void> {
  // ------------- Location.xlsx -> stations, statuses, corridor order
  const loc = new ExcelJS.Workbook()
  await loc.xlsx.readFile(path.join(DATA_DIR, "Location.xlsx"))
  const stations = readSheet(loc, "Location.xlsx")
  stats.stations = stations.length

  type StationInfo = { lat: number; lon: number; status: string }
  const coords = new Map<string, StationInfo>()
  for (const row of stations) {
    const name = text(row["Station"])
    if (!name) continue
    const status = text(row["Status"]) || "Operational"
    coords.set(name, { lat: num(row["Latitude"]), lon: num(row["Longitude"]), status })
  }

  const netStations = NETWORK.stations as Record<string, { lat: number; lon: number; status: string }>
  if (new Set(coords.keys()).size !== new Set(Object.keys(netStations)).size) {
    problems.push(`station count differs: excel=${coords.size} network=${Object.keys(netStations).length}`)
  }
  for (const [name, own] of coords) {
    const net = netStations[name]
    if (!net) {
      problems.push(`${name}: not in network.json`)
      continue
    }
    compare(`${name}/lat`, round(own.lat, 7), round(net.lat, 7))
    compare(`${name}/lon`, round(own.lon, 7), round(net.lon, 7))
  }

  const corridorStations = (corridor: string): string[] =>
    stations.filter((r) => text(r["Line"]) === corridor).map((r) => text(r["Station"]))

  for (const spec of LINES) {
    stats.corridors++
    let stops = corridorStations(spec.corridor)
    if (spec.order === "reversed") stops = [...stops].reverse()
    const netLine = (NETWORK.lines as { id: string; stations: string[] }[]).find((l) => l.id === spec.id)
    if (!netLine) {
      problems.push(`line ${spec.id} missing in network.json`)
      continue
    }
    compare(`line ${spec.id} stations`, stops, netLine.stations)
  }

  // ------------- Fare Matrix.xlsx -> fares
  const fareBook = new ExcelJS.Workbook()
  await fareBook.xlsx.readFile(path.join(DATA_DIR, "Fare Matrix.xlsx"))
  const fareRows = readSheet(fareBook, "Fare Matrix.xlsx")
  const pairs = new Set<string>()
  for (const row of fareRows) {
    const a = text(row["Source"])
    const b = text(row["Destination"])
    if (!a || !b) continue
    // build_network.py keeps every fare row present in the sheet — station status only
    // excuses the *absence* of a fare, it never drops an existing one.
    const fare = Math.round(num(row["Fare"]))
    pairs.add(`${a}|${b}|${fare}`)
    stats.fares++
  }
  // Every operational pair in network.json must be derivable from the sheet (build_network.py
  // accepts a pair when either direction matches, and reports a fix when the two disagree).
  const netFares = NETWORK.fares as Record<string, Record<string, number>>
  for (const [a, row] of Object.entries(netFares)) {
    for (const [b, fare] of Object.entries(row)) {
      if (a < b) continue // stored both directions; check one
      const hit = pairs.has(`${a}|${b}|${fare}`) || pairs.has(`${b}|${a}|${fare}`)
      if (!hit) problems.push(`fare ${a}<->${b}: no Rs ${fare} row for either direction in Fare Matrix.xlsx`)
    }
  }

  // --------------------------------------- report
  console.log(
    `data spike: read ${stats.stations} station rows, ${stats.corridors} corridors, ${stats.fares} fare rows ` +
      `(from ${stations.length} Location rows + fare matrix). ${problems.length} mismatches vs network.json.`,
  )
  for (const problem of problems) console.log("  MISMATCH:", problem)
  const expectedFixes = (NETWORK.data_fixes as string[]).length
  console.log(`network.json carries ${expectedFixes} recorded data_fixes (repair logic ports in Phase 4).`)
  if (problems.length) process.exit(1)
}

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

main().catch((error) => {
  console.error("data spike failed:", error)
  process.exit(1)
})
