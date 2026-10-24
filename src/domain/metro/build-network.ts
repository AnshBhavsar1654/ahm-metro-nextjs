/**
 * Builds network.json from the GMRC sheets, the timetable and the OpenStreetMap track — the 1:1
 * TypeScript port of backend/scripts/build_network.py. Run through scripts/build-network.ts after
 * editing either sheet.
 *
 * Inputs (data/ and src/data/)
 * - Location.xlsx: Station, Latitude, Longitude, Line, Status. Rows of one Line are that corridor's
 *   stations in running order; a station on two corridors (an interchange) has one row per corridor.
 *   Status is Operational, Under construction (trains pass, nobody boards) or Work in progress (a line
 *   being built: routes are shown, fares are not published yet).
 * - Fare Matrix.xlsx: Source, Destination, Fare (rupees). GMRC charges by origin and destination, not
 *   by the route taken, so one fare per pair is all routing needs.
 * - timetable.json: GMRC timetable points, used to estimate the running time of every segment.
 * - tracks.json: the metro track from OpenStreetMap (scripts/fetch-tracks.ts). Each segment between two
 *   stations is traced along it, so maps draw the real track and distances are track lengths. A segment
 *   the track data does not cover falls back to a straight line, and the build says so.
 *
 * The build refuses to produce a network if the data is broken (unknown station, unreachable station,
 * missing fare), and reports every correction it had to make. Every float goes through the Python
 * helpers in ./rounding so the output matches the Python build value for value (tests/network-build).
 */
import { LINE_SPECS, STATUSES, num, text } from "./excel-parse"
import { pyRound, pySum } from "./rounding"

// Lines not in the published timetable and not yet running: time estimated from distance.
const [ESTIMATE_KMH, ESTIMATE_DWELL_MIN] = [34, 0.5]
const TRANSFER_MINUTES = 5 // walking between platforms plus a typical wait
// Blue Line is not in the published timetable: about 15 min Thaltej Gam to Old High Court, 30 min on to Vastral Gam.
const BLUE_TIMING_POINTS: Record<string, number> = { "Thaltej Gam": 0, "Old High Court": 15, "Vastral Gam": 45 }

type Point = [lat: number, lon: number]
type Row = Record<string, unknown>
type Line = { id: string; name: string; corridor: string; status: string; stations: string[] }
type Segment = { line: string; from: string; to: string; km: number; minutes: number; geometry: Point[] }

export type BuildInputs = {
  locationRows: Row[]
  fareRows: Row[]
  timetable: { trains: { stops: [string, string][] }[] }
  tracks: { lines: Record<string, { coords: Point[] }[]> }
}

export type Network = {
  built_from: string[]
  transfer_minutes: number
  stations: Record<string, { lat: number; lon: number; status: string }>
  lines: Line[]
  segments: Segment[]
  fares: Record<string, Record<string, number>>
  data_fixes: string[]
}

export class BuildError extends Error {}

const fail = (message: string): never => {
  throw new BuildError(`build_network: ${message}`)
}

const radians = (x: number) => (x * Math.PI) / 180

export function kmBetween(a: Point, b: Point): number {
  const [lat1, lon1, lat2, lon2] = [a[0], a[1], b[0], b[1]].map(radians) as [number, number, number, number]
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

const metres = (a: Point, b: Point): number => kmBetween(a, b) * 1000

/** Python's float floor division (CPython float_floor_div). */
function floorDiv(a: number, b: number): number {
  let mod = a % b
  let div = (a - mod) / b
  if (mod && b < 0 !== mod < 0) {
    mod += b
    div -= 1
  }
  let floor = Math.floor(div)
  if (div - floor > 0.5) floor += 1
  return floor
}

/** statistics.median */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2
}

const pairs = <T>(items: T[]): [T, T][] => items.slice(1).map((item, i) => [items[i]!, item])

/** heapq on (cost, key) tuples: ties go to the smaller key. */
class Heap<K extends number | string> {
  private items: [number, K][] = []

  get size(): number {
    return this.items.length
  }

  private less(i: number, j: number): boolean {
    const [a, b] = [this.items[i]!, this.items[j]!]
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
  }

  private swap(i: number, j: number): void {
    ;[this.items[i], this.items[j]] = [this.items[j]!, this.items[i]!]
  }

  push(item: [number, K]): void {
    this.items.push(item)
    for (let i = this.items.length - 1; i > 0;) {
      const parent = (i - 1) >> 1
      if (!this.less(i, parent)) break
      this.swap(i, parent)
      i = parent
    }
  }

  pop(): [number, K] {
    const top = this.items[0]!
    const last = this.items.pop()!
    if (this.items.length) {
      this.items[0] = last
      for (let i = 0; ;) {
        const [l, r] = [2 * i + 1, 2 * i + 2]
        let smallest = i
        if (l < this.items.length && this.less(l, smallest)) smallest = l
        if (r < this.items.length && this.less(r, smallest)) smallest = r
        if (smallest === i) break
        this.swap(i, smallest)
        i = smallest
      }
    }
    return top
  }
}

// ---------------------------------------------------------------- stations, lines, running times

function loadStationsAndLines(rows: Row[]) {
  const records = rows
    .map((row) => ({
      station: text(row.Station),
      line: text(row.Line),
      lat: row.Latitude,
      lon: row.Longitude,
      status: row.Status,
    }))
    .filter((r) => r.station)
  const stations = new Map<string, Point>()
  const status = new Map<string, string>()
  for (const row of records) {
    const coord: Point = [pyRound(num(row.lat), 7), pyRound(num(row.lon), 7)]
    const known = stations.get(row.station)
    if (known && (known[0] !== coord[0] || known[1] !== coord[1])) fail(`${row.station} has two different coordinates`)
    stations.set(row.station, coord)
    // pandas: a text cell is the status, an empty (NaN) or numeric cell counts as Operational
    const label = row.status == null || typeof row.status === "number" ? "Operational" : text(row.status)
    if (!(label in STATUSES))
      fail(`${row.station}: unknown Status '${label}' (use one of ${Object.keys(STATUSES).sort().join(", ")})`)
    const value: string = STATUSES[label as keyof typeof STATUSES]
    if (status.has(row.station) && status.get(row.station) !== value) fail(`${row.station} has two different statuses`)
    status.set(row.station, value)
  }

  const onCorridor = (corridor: string) => records.filter((r) => r.line === corridor).map((r) => r.station)
  const lines: Line[] = LINE_SPECS.map((spec) => {
    const stops = onCorridor(spec.corridor)
    if (!stops.length) fail(`no rows for corridor '${spec.corridor}' in Location.xlsx`)
    if (spec.order === "reversed") stops.reverse()
    // Work in progress when no station of its own (interchanges aside) is open yet.
    const elsewhere = new Set(LINE_SPECS.filter((other) => other !== spec).flatMap((other) => onCorridor(other.corridor)))
    const own = stops.filter((s) => !elsewhere.has(s))
    const lineStatus = own.length && own.every((s) => status.get(s) === "work in progress") ? "work in progress" : "operational"
    return { id: spec.id, name: spec.name, corridor: spec.corridor, status: lineStatus, stations: stops }
  })
  const configured = new Set<string>(LINE_SPECS.map((spec) => spec.corridor))
  const unknown = [...new Set(records.map((r) => r.line))].filter((l) => !configured.has(l)).sort()
  if (unknown.length) fail(`corridors in Location.xlsx with no line configured: ${JSON.stringify(unknown)}`)
  return { stations, status, lines }
}

/** Minutes per segment: median timetable time between timing points, spread evenly over the stations between. */
function segmentMinutes(lines: Line[], stations: Map<string, Point>, timetable: BuildInputs["timetable"]): Map<string, number> {
  const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
  const pairKey = (a: string, b: string) => [a, b].sort().join("\u0000")
  const samples = new Map<string, number[]>()
  for (const train of timetable.trains) {
    for (const [[a, ta], [b, tb]] of pairs(train.stops)) {
      const list = samples.get(pairKey(a, b)) ?? []
      list.push(toMinutes(tb) - toMinutes(ta))
      samples.set(pairKey(a, b), list)
    }
  }
  const gaps = new Map([...samples].map(([pair, values]) => [pair, median(values)]))
  const timed = new Set([...gaps.keys()].flatMap((pair) => pair.split("\u0000")))

  const out = new Map<string, number>()
  for (const line of lines) {
    const stops = line.stations
    let points: [index: number, minute: number][]
    if (line.id === "blue") {
      points = stops.flatMap((s, i) => (s in BLUE_TIMING_POINTS ? [[i, BLUE_TIMING_POINTS[s]!] as [number, number]] : []))
    } else if (stops.filter((s) => timed.has(s)).length < 2) {
      // not in the timetable: estimate from distance
      pairs(stops).forEach(([a, b], k) => {
        out.set(
          `${line.id}:${k}`,
          pyRound((kmBetween(stations.get(a)!, stations.get(b)!) / ESTIMATE_KMH) * 60 + ESTIMATE_DWELL_MIN, 2),
        )
      })
      continue
    } else {
      const idx = stops.flatMap((s, i) => (timed.has(s) ? [i] : []))
      let total = 0.0
      points = [[idx[0]!, 0.0]]
      for (const [i, j] of pairs(idx)) {
        total += gaps.get(pairKey(stops[i]!, stops[j]!))!
        points.push([j, total])
      }
    }
    if (points[0]![0] !== 0 || points[points.length - 1]![0] !== stops.length - 1) {
      fail(`${line.name}: timing points do not cover both ends`)
    }
    for (const [[i, ti], [j, tj]] of pairs(points)) {
      for (let k = i; k < j; k++) out.set(`${line.id}:${k}`, pyRound((tj - ti) / (j - i), 2))
    }
  }
  return out
}

// ---------------------------------------------------------------- track tracing

const SNAP_LIMIT_M = 600 // a station further than this from its line's track is not traced
const DENSIFY_M = 25 // long straight stretches get extra points, so a station between two far-apart points can snap
const JOIN_GAP_M = 40 // track pieces whose ends are this close are joined (small gaps in the map data)
const SIMPLIFY_M = 3
const MAX_DETOUR = 1.6 // a traced path longer than this x the straight distance (+300 m) is a wrong turn

/** The track of one line (or of all lines) as a graph of points. */
class Track {
  readonly points: Point[] = []
  private readonly edges: [node: number, metres: number][][] = []
  private readonly pieceNodes: number[][] = []

  constructor(ways: { coords: Point[] }[]) {
    const index = new Map<string, number>()
    const node = (p: Point): number => {
      const key: Point = [pyRound(p[0], 6), pyRound(p[1], 6)] // pieces share their junction points
      const id = `${key[0]},${key[1]}`
      if (!index.has(id)) {
        index.set(id, this.points.length)
        this.points.push(key)
        this.edges.push([])
      }
      return index.get(id)!
    }

    const ends: number[] = []
    for (const way of ways) {
      const coords: Point[] = []
      for (const [p, q] of pairs(way.coords)) {
        const steps = Math.max(1, floorDiv(metres(p, q), DENSIFY_M))
        for (let k = 0; k < steps; k++) coords.push([p[0] + ((q[0] - p[0]) * k) / steps, p[1] + ((q[1] - p[1]) * k) / steps])
      }
      coords.push(way.coords[way.coords.length - 1]!)
      const ids = coords.map(node)
      this.pieceNodes.push(ids)
      for (const [a, b] of pairs(ids)) this.link(a, b)
      ends.push(ids[0]!, ids[ids.length - 1]!)
    }
    // bridge small gaps between pieces
    ends.forEach((a, i) => {
      for (const b of ends.slice(i + 1)) {
        if (a !== b && metres(this.points[a]!, this.points[b]!) < JOIN_GAP_M) this.link(a, b)
      }
    })
  }

  private link(a: number, b: number): void {
    const d = metres(this.points[a]!, this.points[b]!)
    this.edges[a]!.push([b, d])
    this.edges[b]!.push([a, d])
  }

  /**
   * The nearest point on each nearby piece of track (closest first). Double track is mapped as one piece
   * per direction, so a station has a candidate on each; tracing tries them all.
   */
  candidates(p: Point, limit = 4): number[] {
    const found = new Map<number, number>()
    for (const ids of this.pieceNodes) {
      let best = ids[0]!
      for (const i of ids) if (metres(this.points[i]!, p) < metres(this.points[best]!, p)) best = i
      const d = metres(this.points[best]!, p)
      if (d <= SNAP_LIMIT_M) found.set(best, Math.min(d, found.get(best) ?? d))
    }
    return [...found.keys()].sort((a, b) => found.get(a)! - found.get(b)!).slice(0, limit)
  }

  path(a: number, b: number): Point[] | null {
    const dist = new Map<number, number>([[a, 0.0]])
    const prev = new Map<number, number>()
    const heap = new Heap<number>()
    heap.push([0.0, a])
    while (heap.size) {
      const [d, u] = heap.pop()
      if (u === b) {
        const out = [b]
        while (out[out.length - 1] !== a) out.push(prev.get(out[out.length - 1]!)!)
        return out.reverse().map((i) => this.points[i]!)
      }
      if (d > dist.get(u)!) continue
      for (const [v, w] of this.edges[u]!) {
        if (d + w < (dist.get(v) ?? Infinity)) {
          dist.set(v, d + w)
          prev.set(v, u)
          heap.push([d + w, v])
        }
      }
    }
    return null
  }
}

/** Douglas-Peucker on a short path (flat-earth distances are fine at this scale). */
function simplify(points: Point[], toleranceM = SIMPLIFY_M): Point[] {
  if (points.length < 3) return points
  const lat0 = radians(points[0]![0])
  const xy = points.map((p) => [p[1] * 111320 * Math.cos(lat0), p[0] * 110540] as const)
  const keep = points.map(() => false)
  keep[0] = keep[keep.length - 1] = true
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()!
    const [[x1, y1], [x2, y2]] = [xy[i]!, xy[j]!]
    const seg = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5 || 1e-9
    let [far, farD]: [number | null, number] = [null, toleranceM]
    for (let k = i + 1; k < j; k++) {
      const [x0, y0] = xy[k]!
      const d = Math.abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1) / seg
      if (d > farD) [far, farD] = [k, d]
    }
    if (far !== null) {
      keep[far] = true
      stack.push([i, far], [far, j])
    }
  }
  return points.filter((_, k) => keep[k])
}

const pathLength = (path: Point[], measure: (a: Point, b: Point) => number) => pySum(pairs(path).map(([p, q]) => measure(p, q)))

/** (line id, from, to) -> geometry along the track. Segments drawn straight are added to `notes`. */
function traceSegments(stations: Map<string, Point>, lines: Line[], tracks: BuildInputs["tracks"], notes: string[]) {
  const everyLine = new Track(Object.values(tracks.lines).flat())
  const shared = tracks.lines.shared ?? []
  const traced = new Map<string, Point[]>()
  for (const line of lines) {
    const own = tracks.lines[line.id]?.length ? new Track([...tracks.lines[line.id]!, ...shared]) : null
    for (const [a, b] of pairs(line.stations)) {
      const [pa, pb] = [stations.get(a)!, stations.get(b)!]
      const straight = metres(pa, pb)
      let geometry: Point[] | null = null
      for (const track of [own, everyLine]) {
        // a line's own track first; others cover shared stretches
        if (!track) continue
        let best: [number, Point[]] | null = null
        for (const na of track.candidates(pa)) {
          for (const nb of track.candidates(pb)) {
            const path = na !== nb ? track.path(na, nb) : null
            if (!path) continue
            const length = pathLength(path, metres)
            if (length <= MAX_DETOUR * straight + 300 && (best === null || length < best[0])) best = [length, path]
          }
        }
        if (best) {
          geometry = [[...pa], ...simplify(best[1]).map((p): Point => [...p]), [...pb]]
          break
        }
      }
      if (geometry === null) {
        geometry = [[...pa], [...pb]]
        notes.push(`${line.name} ${a} -> ${b}: no track in tracks.json, drawn as a straight line.`)
      }
      traced.set(`${line.id}\u0000${a}\u0000${b}`, geometry)
    }
  }
  return traced
}

// ---------------------------------------------------------------- fares

function shortestKm(stations: Map<string, Point>, segments: Segment[]): Map<string, Map<string, number>> {
  const graph = new Map<string, [string, number][]>()
  const add = (from: string, to: string, km: number) => graph.set(from, [...(graph.get(from) ?? []), [to, km]])
  for (const seg of segments) {
    add(seg.from, seg.to, seg.km)
    add(seg.to, seg.from, seg.km)
  }
  const fromStation = (src: string) => {
    const dist = new Map<string, number>([[src, 0.0]])
    const heap = new Heap<string>()
    heap.push([0.0, src])
    while (heap.size) {
      const [d, s] = heap.pop()
      if (d > dist.get(s)!) continue
      for (const [t, w] of graph.get(s) ?? []) {
        if (d + w < (dist.get(t) ?? Infinity)) {
          dist.set(t, d + w)
          heap.push([d + w, t])
        }
      }
    }
    return dist
  }
  return new Map([...stations.keys()].map((s) => [s, fromStation(s)]))
}

function loadFares(rows: Row[], stations: Map<string, Point>, status: Map<string, string>, km: Map<string, Map<string, number>>) {
  const raw = new Map<string, number>()
  const key = (a: string, b: string) => `${a}\u0000${b}`
  for (const row of rows) {
    const [a, b] = [text(row.Source), text(row.Destination)]
    if (!a && !b) continue
    if (!stations.has(a) || !stations.has(b)) fail(`Fare Matrix.xlsx names an unknown station: '${a}' / '${b}'`)
    const fare = Math.trunc(num(row.Fare))
    if (raw.has(key(a, b)) && raw.get(key(a, b)) !== fare) fail(`two different fares for ${a} -> ${b}`)
    raw.set(key(a, b), fare)
  }

  // Distance band of every fare, from the pairs whose two directions agree. Used to settle disagreements.
  const bands = new Map<number, [number, number]>()
  for (const [pair, fare] of raw) {
    const [a, b] = pair.split("\u0000") as [string, string]
    if (a !== b && raw.get(key(b, a)) === fare) {
      const [lo, hi] = bands.get(fare) ?? [Infinity, 0.0]
      const d = km.get(a)!.get(b)!
      bands.set(fare, [Math.min(lo, d), Math.max(hi, d)])
    }
  }

  const fares = new Map<string, Map<string, number>>()
  const fixes: string[] = []
  const set = (a: string, b: string, fare: number) => fares.set(a, (fares.get(a) ?? new Map()).set(b, fare))
  const names = [...stations.keys()].sort()
  names.forEach((a, i) => {
    for (const b of names.slice(i)) {
      const [there, back] = [raw.get(key(a, b)), raw.get(key(b, a))]
      if (there === undefined && back === undefined) {
        if (status.get(a) === "work in progress" || status.get(b) === "work in progress") continue // no fares published yet
        fail(`no fare for ${a} <-> ${b}`)
      }
      let fare = (back === undefined ? there : there === undefined ? back : there)!
      if (there !== undefined && back !== undefined && there !== back) {
        const distance = km.get(a)!.get(b)!
        const fitting = [there, back].filter((f) => {
          const [lo, hi] = bands.get(f) ?? [0, 0]
          return lo <= distance && distance <= hi
        })
        fare = fitting.length ? Math.min(...fitting) : Math.min(there, back)
        fixes.push(
          `Fare Matrix.xlsx: ${a} -> ${b} is Rs ${there} but ${b} -> ${a} is Rs ${back}; ` +
            `using Rs ${fare} for both (${pyRound(distance, 1).toFixed(1)} km fits that fare's distance band).`,
        )
      }
      set(a, b, fare)
      set(b, a, fare)
    }
  })
  return { fares, fixes }
}

// ---------------------------------------------------------------- the build

/** The network, as build_network.py wrote it. Throws BuildError on broken data. */
export function buildNetwork(inputs: BuildInputs): Network {
  const { stations, status, lines } = loadStationsAndLines(inputs.locationRows)
  const minutes = segmentMinutes(lines, stations, inputs.timetable)
  for (const line of lines) {
    const missing = line.stations.filter((s) => !stations.has(s))
    if (missing.length) fail(`${line.name}: no coordinates for ${JSON.stringify(missing)}`)
  }
  const trackNotes: string[] = []
  const traced = traceSegments(stations, lines, inputs.tracks, trackNotes)
  const segments: Segment[] = []
  for (const line of lines) {
    pairs(line.stations).forEach(([a, b], k) => {
      const geometry = traced.get(`${line.id}\u0000${a}\u0000${b}`)!
      const km = pathLength(geometry, kmBetween) // along the track
      segments.push({ line: line.id, from: a, to: b, km: pyRound(km, 3), minutes: minutes.get(`${line.id}:${k}`)!, geometry })
    })
  }

  const km = shortestKm(stations, segments)
  const unreachable = [...stations.keys()].filter((s) => km.get(s)!.size !== stations.size)
  if (unreachable.length) fail(`stations not connected to the rest of the network: ${JSON.stringify(unreachable)}`)
  const { fares, fixes } = loadFares(inputs.fareRows, stations, status, km)

  const sortedEntries = <V>(map: Map<string, V>) => [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    built_from: ["Location.xlsx", "Fare Matrix.xlsx", "timetable.json", "tracks.json (OpenStreetMap contributors, ODbL)"],
    transfer_minutes: TRANSFER_MINUTES,
    stations: Object.fromEntries(sortedEntries(stations).map(([s, [lat, lon]]) => [s, { lat, lon, status: status.get(s)! }])),
    lines,
    segments,
    fares: Object.fromEntries(sortedEntries(fares).map(([a, row]) => [a, Object.fromEntries(sortedEntries(row))])),
    data_fixes: [...fixes, ...trackNotes],
  }
}
