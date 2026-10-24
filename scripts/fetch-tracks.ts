/**
 * Downloads the metro track geometry into data/tracks.json — the port of backend/scripts/fetch_tracks.py.
 * Run when the network changes (new line or extension), then rebuild:
 *
 *     bun run data:tracks
 *     bun run data:network
 *
 * Sources, all OpenStreetMap:
 * 1. every metro track in the Ahmedabad-Gandhinagar area (Overpass API). This is complete on its own.
 * 2. When Overpass is busy: each line's route relations from the main OpenStreetMap API, merged with the
 *    track already saved in data/tracks.json, so a refresh never loses track it had (route relations miss
 *    some pieces).
 * Depot, yard and siding tracks are left out: a traced path must never run through them.
 *
 * Each piece is filed under its line by name; unnamed main-line pieces (crossovers, junctions) go under
 * "shared". Map data © OpenStreetMap contributors (ODbL).
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pyRound } from "../src/domain/metro/rounding"

const DATA_DIR = path.join(import.meta.dirname, "..", "data")
const HEADERS = { "User-Agent": "AhmedabadMetroApp/1.0 (track geometry for a rider website)" }
const OSM_API = "https://api.openstreetmap.org/api/0.6"
const OVERPASS_URLS = [
  // public servers, tried in order (the main one is often busy)
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
]

// OpenStreetMap route relations per line (both directions). Find new ones with an Overpass query for
// relation["route"="subway"] around Ahmedabad.
const RELATIONS: Record<string, number[]> = {
  blue: [8312433, 9521935],
  red: [8312443, 14658372],
  yellow: [18391194, 18391195],
  violet: [18084555, 18084556],
}
// Lines still being built have no route relation yet; their planned track is mapped as single ways.
const PLANNED_WAYS: Record<string, number[]> = {
  lightblue: [1482920013], // GIFT City to Shahpur extension (railway=proposed)
}

const AREA = "(22.95,72.48,23.27,72.72)" // south, west, north, east: Ahmedabad to Gandhinagar and GIFT City

// Piece name -> line. Checked in order; OpenStreetMap names vary ("Line-2: Motera Stadium – Mahatma Mandir").
const NAME_TO_LINE: [string, string][] = [
  ["blue line", "blue"],
  ["red line", "red"],
  ["yellow line", "yellow"],
  ["line-2", "yellow"],
  ["violet line", "violet"],
  ["gift city", "violet"],
]
const NOT_MAIN_LINE = new Set(["yard", "siding", "spur", "depot"])

type Piece = { id: string; coords: [number, number][] }
type OsmElement = {
  type: string
  id: number
  lat?: number
  lon?: number
  nodes?: number[]
  tags?: Record<string, string>
  geometry?: { lat: number; lon: number }[]
}

async function getJson(url: string, body?: string): Promise<{ elements: OsmElement[] }> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" } : HEADERS,
    body,
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as { elements: OsmElement[] }
}

const lineFor = (name: string | undefined): string | null =>
  NAME_TO_LINE.find(([key]) => (name ?? "").toLowerCase().includes(key))?.[1] ?? null

const point = (lat: number, lon: number): [number, number] => [pyRound(lat, 7), pyRound(lon, 7)]

/** Every main-line metro track in AREA, as [line or "shared", piece], or null if Overpass is unavailable. */
async function areaFromOverpass(): Promise<[string, Piece][] | null> {
  const query = `[out:json][timeout:120];way["railway"="subway"]${AREA};out geom tags;`
  for (const url of OVERPASS_URLS) {
    let result
    try {
      result = await getJson(url, new URLSearchParams({ data: query }).toString())
    } catch (exc) {
      console.log(`  ${url}: ${exc instanceof Error ? exc.message : String(exc)}`)
      continue
    }
    return result.elements
      .filter((el) => el.type === "way" && el.geometry?.length && !NOT_MAIN_LINE.has(el.tags?.service ?? ""))
      .map((el): [string, Piece] => [
        lineFor(el.tags?.name) ?? "shared",
        { id: `way/${el.id}`, coords: el.geometry!.map((p) => point(p.lat, p.lon)) },
      ])
  }
  return null
}

const nodesOf = (elements: OsmElement[]) =>
  new Map(elements.filter((el) => el.type === "node").map((el) => [el.id, [el.lat!, el.lon!] as const]))

/** Planned track (single OpenStreetMap ways) from the main OpenStreetMap API. */
async function plannedWays(wayIds: number[]): Promise<Piece[]> {
  const ways: Piece[] = []
  for (const wid of wayIds) {
    const { elements } = await getJson(`${OSM_API}/way/${wid}/full.json`)
    const nodes = nodesOf(elements)
    const way = elements.find((el) => el.type === "way")!
    ways.push({ id: `way/${wid}`, coords: way.nodes!.map((n) => point(...nodes.get(n)!)) })
  }
  return ways
}

/** The main OpenStreetMap API: each relation with all its ways and nodes ("full"). */
async function waysFromOsmApi(relationIds: number[]): Promise<(Piece & { service?: string })[]> {
  const ways = new Map<number, Piece & { service?: string }>()
  for (const rid of relationIds) {
    const { elements } = await getJson(`${OSM_API}/relation/${rid}/full.json`)
    const nodes = nodesOf(elements)
    for (const el of elements) {
      if (el.type === "way" && el.tags && "railway" in el.tags) {
        ways.set(el.id, {
          id: `way/${el.id}`,
          service: el.tags.service,
          coords: (el.nodes ?? []).filter((n) => nodes.has(n)).map((n) => point(...nodes.get(n)!)),
        })
      }
    }
  }
  return [...ways.values()]
}

async function main(): Promise<void> {
  const lines = new Map<string, Map<string, Piece>>([...Object.keys(RELATIONS), "shared"].map((line) => [line, new Map()]))
  const lineMap = (line: string) => lines.get(line) ?? lines.set(line, new Map()).get(line)!

  const pieces = await areaFromOverpass()
  if (pieces !== null) {
    for (const [line, piece] of pieces) lineMap(line).set(piece.id, piece)
  } else {
    console.log("Overpass unavailable: using the route relations plus the track already saved")
    try {
      const saved = JSON.parse(readFileSync(path.join(DATA_DIR, "tracks.json"), "utf8")) as { lines: Record<string, Piece[]> }
      for (const [line, list] of Object.entries(saved.lines)) for (const piece of list) lineMap(line).set(piece.id, piece)
    } catch {
      /* no saved track yet */
    }
    for (const [line, relationIds] of Object.entries(RELATIONS)) {
      for (const { service, ...way } of await waysFromOsmApi(relationIds)) {
        if (!NOT_MAIN_LINE.has(service ?? "")) lineMap(line).set(way.id, way)
      }
    }
  }

  for (const [line, wayIds] of Object.entries(PLANNED_WAYS)) {
    for (const way of await plannedWays(wayIds)) lineMap(line).set(way.id, way)
  }

  for (const [line, found] of lines) {
    if (line !== "shared" && !(line in PLANNED_WAYS) && !found.size) {
      console.error(`fetch_tracks: no track found for the ${line} line`)
      process.exit(1)
    }
    console.log(`${line}: ${found.size} pieces, ${[...found.values()].reduce((n, p) => n + p.coords.length, 0)} points`)
  }

  const output = {
    source: "OpenStreetMap contributors (ODbL)",
    relations: RELATIONS,
    lines: Object.fromEntries([...lines].map(([line, found]) => [line, [...found.values()]])),
  }
  writeFileSync(path.join(DATA_DIR, "tracks.json"), JSON.stringify(output))
  console.log("saved data/tracks.json")
}

main().catch((error) => {
  console.error("fetch-tracks failed:", error)
  process.exit(1)
})
