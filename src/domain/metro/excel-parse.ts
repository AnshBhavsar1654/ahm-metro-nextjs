/**
 * Excel parsing for the metro data pipeline — the TypeScript port of build_network.py's
 * pandas layer (Phase 1 spike → shared by scripts + tests; the full build lands in Phase 4).
 *
 * Contract captured during the Phase 1 data spike (all verified against the committed network.json):
 * - pandas reads the first sheet with row 1 as trimmed headers; `df["col"].str.strip()` trims every cell.
 * - Cell values may arrive from exceljs as rich-text objects, formula results or numbers; text() mirrors
 *   what pandas would have shown as a string.
 * - Fare rows are matched pair-wise: a fare counts when EITHER direction matches (build_network.py's
 *   load_fares fills the reverse direction from whichever row exists). Station status only excuses the
 *   *absence* of a fare — it never drops a fare row that the sheet does carry.
 */
import type ExcelJS from "exceljs"

/** Excel corridor → line as shown in the app. `order` is the running order the app uses. */
export const LINE_SPECS = [
  { id: "red", name: "Red Line", corridor: "North South Corridor", order: "as listed" },
  { id: "blue", name: "Blue Line", corridor: "East West Corridor", order: "reversed" },
  { id: "yellow", name: "Yellow Line", corridor: "Corridor-1", order: "as listed" },
  { id: "violet", name: "Violet Line", corridor: "Corridor-2", order: "as listed" },
  { id: "pink", name: "Pink Line", corridor: "Airport Corridor", order: "as listed" },
  { id: "lightblue", name: "Light Blue Line", corridor: "GIFT City Extension", order: "as listed" },
] as const

export const STATUSES = {
  Operational: "operational",
  "Under construction": "under construction",
  "Work in progress": "work in progress",
} as const

export type StationStatus = (typeof STATUSES)[keyof typeof STATUSES]

export type StationInfo = { lat: number; lon: number; status: string }

export type ParsedLocation = {
  stations: Map<string, StationInfo>
  corridors: Map<string, string[]>
}

export const round = (n: number, digits: number): number => {
  const factor = 10 ** digits
  return Math.round(n * factor) / factor
}

/** exceljs stringifies cells differently from pandas; both must end at the same trimmed string. */
export function text(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" || typeof value === "boolean") return String(value).trim()
  if (typeof value === "object") {
    const rich = value as { result?: unknown; richText?: { text: string }[]; text?: string }
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

/** float(row.Latitude) — the coercion every numeric column gets. */
export function num(value: unknown): number {
  return Number(text(value))
}

/** Reads one worksheet template into rows keyed by trimmed header text (df.read_excel's shape). */
export function readSheet(sheet: ExcelJS.Worksheet): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  let headers: string[] | null = null
  sheet.eachRow((row) => {
    const values = (row.values as unknown[]) ?? []
    if (headers === null) {
      headers = values.slice(1).map((v) => text(v))
      return
    }
    const record: Record<string, unknown> = {}
    headers.forEach((header, index) => (record[header] = values[index + 1]))
    rows.push(record)
  })
  return rows
}

export function parseLocationRows(rows: Record<string, unknown>[]): ParsedLocation {
  const stations = new Map<string, StationInfo>()
  const corridors = new Map<string, string[]>()
  for (const row of rows) {
    const name = text(row["Station"])
    if (!name) continue
    const label = text(row["Status"]) || "Operational"
    const status = label in STATUSES ? STATUSES[label as keyof typeof STATUSES] : label
    const lat = num(row["Latitude"])
    const lon = num(row["Longitude"])
    const existing = stations.get(name)
    if (existing && (round(existing.lat, 7) !== round(lat, 7) || round(existing.lon, 7) !== round(lon, 7))) {
      throw new Error(`${name} has two different coordinates`)
    }
    if (existing && existing.status !== status) {
      throw new Error(`${name} has two different statuses`)
    }
    stations.set(name, { lat, lon, status })
    const corridor = text(row["Line"])
    const stops = corridors.get(corridor) ?? []
    if (!stops.includes(name)) stops.push(name)
    corridors.set(corridor, stops)
  }
  return { stations, corridors }
}

/** The running order of a line's stations, per the corridor spec. */
export function lineStations(spec: { corridor: string; order: string }, parsed: ParsedLocation): string[] {
  const stops = [...(parsed.corridors.get(spec.corridor) ?? [])]
  return spec.order === "reversed" ? [...stops].reverse() : stops
}

/**
 * build_network.py: a line is "work in progress" when every station that belongs only to it
 * (interchanges aside) is still work in progress; otherwise the line is operational.
 */
export function derivedLineStatus(spec: { corridor: string }, parsed: ParsedLocation): string {
  const shared = new Set<string>()
  for (const other of LINE_SPECS.map((line) => line.corridor)) {
    if (other === spec.corridor) continue
    for (const name of parsed.corridors.get(other) ?? []) shared.add(name)
  }
  const own = (parsed.corridors.get(spec.corridor) ?? []).filter((name) => !shared.has(name))
  if (own.length && own.every((name) => parsed.stations.get(name)?.status === "work in progress")) {
    return "work in progress"
  }
  return "operational"
}

/** Source|Destination → fare (Rs). */
export function parseFareRows(rows: Record<string, unknown>[]): Map<string, number> {
  const fares = new Map<string, number>()
  for (const row of rows) {
    const a = text(row["Source"])
    const b = text(row["Destination"])
    if (!a || !b) continue
    fares.set(`${a}|${b}`, Math.round(num(row["Fare"])))
  }
  return fares
}
