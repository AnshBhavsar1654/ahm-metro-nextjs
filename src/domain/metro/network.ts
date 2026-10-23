/**
 * Routes and fares over the metro network described in src/data/network.json — the 1:1
 * TypeScript port of backend/metro/network.py.
 *
 * Routing works on (station, line) states, so changing line has a cost of its own:
 * - riding one segment costs its running time (minutes, from the timetable);
 * - changing line at an interchange costs `transfer_minutes`.
 * Dijkstra gives the quickest route; Yen's algorithm gives the next-quickest genuinely different
 * routes, so the planner keeps working once the network has loops or parallel lines.
 *
 * Fares are looked up per origin and destination: GMRC charges by the two stations, whatever the
 * route. Station status: "operational", "under construction" (trains pass through, nobody boards)
 * or "work in progress" (fares and trains not published yet).
 *
 * Every float that reaches a payload is rounded the Python way (./rounding): the golden tests pin
 * these outputs to the FastAPI implementation field for field, over all station pairs.
 */
import networkData from "@/data/network.json"
import { pyRound } from "./rounding"

export type State = [station: string, line: string]

type RideEdge = [state: State, minutes: number, km: number]

type LineData = {
  id: string
  name: string
  corridor: string
  status: string
  stations: string[]
}

export type RouteLeg = { line: string; from: string; to: string; stops: number }

export type Route = {
  route: string[]
  legs: RouteLeg[]
  interchanges: string[]
  distance: number
  minutes: number | null
  geometry: [number, number][]
  instructions: string[]
  error: string | null
  not_operational?: Record<string, string>
  alternatives?: Route[]
}

export const OPERATIONAL = "operational"
export const UNDER_CONSTRUCTION = "under construction"
export const WORK_IN_PROGRESS = "work in progress"
const START: State = ["", "start"]
const END: State = ["", "end"]
const INFINITY = Number.POSITIVE_INFINITY

export type NetworkData = {
  transfer_minutes?: number
  stations: Record<string, { lat: number; lon: number; status?: string }>
  lines: { id: string; name: string; corridor?: string; status?: string; stations: string[] }[]
  segments: {
    line: string
    from: string
    to: string
    km: number
    minutes: number
    geometry: [number, number][] | null
  }[]
  fares?: Record<string, Record<string, number>>
}

const segKey = (line: string, a: string, b: string) => `${line}\u0000${a}\u0000${b}`
const stateKey = (state: State): string => `${state[0]}\u0000${state[1]}`
const stateKeyList = (path: State[]): string => path.map(stateKey).join(">")
const sameState = (a: State, b: State): boolean => a[0] === b[0] && a[1] === b[1]
const zip = <T>(items: T[]): [T, T][] => {
  const pairs: [T, T][] = []
  for (let i = 0; i + 1 < items.length; i++) pairs.push([items[i]!, items[i + 1]!])
  return pairs
}
const samePathPrefix = (path: State[], root: State[], length: number): boolean =>
  path.length >= length && root.every((state, i) => sameState(state, path[i]!))

/** A binary min-heap ordered by (cost, tie) — the exact pop order backend's heapq gives, because
 * backend/metro/network.py breaks cost ties with an incrementing counter before the state. */
class MinHeap<T> {
  private items: { cost: number; tie: number; value: T }[] = []

  get size(): number {
    return this.items.length
  }

  push(cost: number, tie: number, value: T): void {
    this.items.push({ cost, tie, value })
    let i = this.items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.less(i, parent)) {
        ;[this.items[i], this.items[parent]] = [this.items[parent]!, this.items[i]!]
        i = parent
      } else break
    }
  }

  pop(): [number, T] | undefined {
    if (!this.items.length) return undefined
    const top = this.items[0]!
    const last = this.items.pop()!
    if (this.items.length) {
      this.items[0] = last
      let i = 0
      for (;;) {
        const left = 2 * i + 1
        const right = left + 1
        let smallest = i
        if (left < this.items.length && this.less(left, smallest)) smallest = left
        if (right < this.items.length && this.less(right, smallest)) smallest = right
        if (smallest === i) break
        ;[this.items[i], this.items[smallest]] = [this.items[smallest]!, this.items[i]!]
        i = smallest
      }
    }
    return [top.cost, top.value]
  }

  private less(a: number, b: number): boolean {
    const x = this.items[a]!
    const y = this.items[b]!
    return x.cost < y.cost || (x.cost === y.cost && x.tie < y.tie)
  }
}

export class Network {
  readonly transferMinutes: number
  readonly coords: Map<string, [lat: number, lon: number]>
  readonly status: Map<string, string>
  readonly lines: LineData[]
  readonly lineName: Map<string, string>
  readonly fares: Record<string, Record<string, number>>
  private readonly lookup: Map<string, string>
  /** Riding edges, both directions, keyed by (station, line) state. */
  private readonly ride: Map<string, RideEdge[]>
  readonly stationLines: Map<string, string[]>
  /** Track geometry of each segment, stored in the direction it was built (from -> to). */
  private readonly geometry: Map<string, [number, number][]>

  constructor(data: NetworkData) {
    this.transferMinutes = data.transfer_minutes ?? 5
    this.coords = new Map(Object.entries(data.stations).map(([name, c]) => [name, [c.lat, c.lon]] as [string, [number, number]]))
    this.status = new Map(Object.entries(data.stations).map(([name, c]) => [name, c.status ?? OPERATIONAL]))
    this.lines = data.lines.map((line) => ({
      id: line.id,
      name: line.name,
      corridor: line.corridor ?? "",
      status: line.status ?? OPERATIONAL,
      stations: line.stations,
    }))
    this.lineName = new Map(this.lines.map((line) => [line.id, line.name]))
    this.fares = data.fares ?? {}
    this.lookup = new Map([...this.coords.keys()].map((name) => [name.toLowerCase(), name]))

    this.ride = new Map()
    this.stationLines = new Map()
    this.geometry = new Map()
    for (const seg of data.segments) {
      const fromCoord = this.coords.get(seg.from)!
      const toCoord = this.coords.get(seg.to)!
      const fallback: [number, number][] = [
        [fromCoord[0], fromCoord[1]],
        [toCoord[0], toCoord[1]],
      ]
      // Python: seg.get("geometry") or fallback — an empty list falls back too.
      this.geometry.set(segKey(seg.line, seg.from, seg.to), seg.geometry?.length ? seg.geometry : fallback)
      const a: State = [seg.from, seg.line]
      const b: State = [seg.to, seg.line]
      if (!this.ride.has(stateKey(a))) this.ride.set(stateKey(a), [])
      if (!this.ride.has(stateKey(b))) this.ride.set(stateKey(b), [])
      this.ride.get(stateKey(a))!.push([b, seg.minutes, seg.km])
      this.ride.get(stateKey(b))!.push([a, seg.minutes, seg.km])
      for (const s of [seg.from, seg.to]) {
        const lines = this.stationLines.get(s) ?? []
        if (!lines.includes(seg.line)) lines.push(seg.line)
        this.stationLines.set(s, lines)
      }
    }
  }

  // ---------------------------------------------------------------- graph

  private edges(state: State, src: string, dst: string): [State, number][] {
    if (state[1] === START[1] && state[0] === START[0]) {
      return (this.stationLines.get(src) ?? []).map((line) => [[src, line], 0] as [State, number])
    }
    const [station, line] = state
    const out: [State, number][] = (this.ride.get(stateKey(state)) ?? []).map(
      ([next, minutes]) => [next, minutes] as [State, number],
    )
    for (const other of this.stationLines.get(station) ?? []) {
      if (other !== line) out.push([[station, other], this.transferMinutes])
    }
    if (station === dst) out.push([END, 0])
    return out
  }

  private dijkstra(
    src: string,
    dst: string,
    bannedEdges: Set<string> = new Set(),
    bannedStates: Set<string> = new Set(),
    start: State = START,
    startCost = 0,
  ): [number, State[]] | null {
    const dist = new Map<string, number>([[stateKey(start), startCost]])
    const prev = new Map<string, State>()
    const heap = new MinHeap<State>()
    let tie = 0
    heap.push(startCost, tie++, start)
    while (heap.size) {
      const [cost, state] = heap.pop()!
      if (sameState(state, END)) {
        const path: State[] = [state]
        while (!sameState(path[path.length - 1]!, start)) {
          path.push(prev.get(stateKey(path[path.length - 1]!))!)
        }
        return [cost, path.reverse()]
      }
      const stateId = stateKey(state)
      if (cost > (dist.get(stateId) ?? INFINITY)) continue
      for (const [next, weight] of this.edges(state, src, dst)) {
        if (bannedStates.has(stateKey(next))) continue
        if (bannedEdges.has(`${stateId}>${stateKey(next)}`)) continue
        if (cost + weight < (dist.get(stateKey(next)) ?? INFINITY)) {
          dist.set(stateKey(next), cost + weight)
          prev.set(stateKey(next), state)
          tie++
          heap.push(cost + weight, tie, next)
        }
      }
    }
    return null
  }

  private cost(path: State[], src: string, dst: string): number {
    let total = 0
    for (const [a, b] of zip(path)) {
      for (const [next, weight] of this.edges(a, src, dst)) {
        if (sameState(next, b)) {
          total += weight
          break
        }
      }
    }
    return total
  }

  /** Yen's algorithm over (station, line) states: up to k loopless paths, quickest first. */
  private kShortest(src: string, dst: string, k: number): [number, State[]][] {
    const first = this.dijkstra(src, dst)
    if (!first) return []
    const found: [number, State[]][] = [first]
    const candidates = new MinHeap<State[]>()
    const seen = new Set<string>([stateKeyList(first[1])])
    let tie = 0
    while (found.length < k) {
      const last = found[found.length - 1]![1]
      for (let i = 0; i < last.length - 2; i++) {
        const root = last.slice(0, i + 1)
        const bannedEdges = new Set<string>()
        for (const [, path] of found) {
          if (samePathPrefix(path, root, i + 1)) {
            bannedEdges.add(`${stateKey(path[i]!)}>${stateKey(path[i + 1]!)}`)
          }
        }
        const bannedStates = new Set(root.slice(0, -1).map(stateKey))
        const spur = last[i]!
        const result = this.dijkstra(src, dst, bannedEdges, bannedStates, spur, this.cost(root, src, dst))
        if (!result) continue
        const [cost, tail] = result
        const path = [...root.slice(0, -1), ...tail]
        const key = stateKeyList(path)
        if (seen.has(key)) continue
        seen.add(key)
        tie++
        candidates.push(cost, tie, path)
      }
      if (!candidates.size) break
      const [costOfLoop, path] = candidates.pop()!
      found.push([costOfLoop, path])
    }
    return found
  }

  // ---------------------------------------------------------------- results

  private describe(minutes: number, path: State[]): Route | null {
    const states = path.filter((s) => !sameState(s, START) && !sameState(s, END))
    const route: string[] = [states[0]![0]]
    for (const s of states.slice(1)) {
      if (s[0] !== route[route.length - 1]) route.push(s[0])
    }
    if (route.length !== new Set(route).size) {
      return null // passes a station twice: never a sensible journey
    }

    // Line used to reach each station along the route, and the legs between line changes.
    const legs: RouteLeg[] = []
    let km = 0
    const geometry: [number, number][] = []
    for (const [a, b] of zip(states)) {
      if (a[0] === b[0]) continue // a change of line
      for (const [next, , kmEdge] of this.ride.get(stateKey(a))!) {
        if (sameState(next, b)) {
          km += kmEdge
          break
        }
      }
      const piece = this.segmentGeometry(a[1], a[0], b[0])
      const additions = geometry.length ? piece.slice(1) : piece
      for (const point of additions) geometry.push(point)
      const line = this.lineName.get(a[1])!
      const lastLeg = legs[legs.length - 1]
      if (lastLeg && lastLeg.line === line && lastLeg.to === a[0]) {
        lastLeg.to = b[0]
        lastLeg.stops++
      } else {
        legs.push({ line, from: a[0], to: b[0], stops: 1 })
      }
    }

    const interchanges = legs.slice(0, -1).map((leg) => leg.to)
    const instructions = [`Start at ${route[0]} (Take ${legs[0]!.line})`]
    const changes = new Map(zip(legs).map(([leg, next]) => [leg.to, [leg.line, next.line]] as const))
    for (const station of route.slice(1)) {
      if (changes.has(station)) {
        const [from, to] = changes.get(station)!
        instructions.push(`${station} (Change from ${from} to ${to})`)
      } else {
        instructions.push(station)
      }
    }
    return {
      route,
      legs,
      interchanges,
      distance: pyRound(km, 2),
      minutes: pyRound(minutes, 1),
      geometry,
      instructions,
      error: null,
    }
  }

  findRoutes(source: string, destination: string, maxRoutes: number = 3): Route[] {
    const src = this.resolve(source) // "resolve" at this layer means the canonical name
    const dst = this.resolve(destination)
    if (!src || !dst || src === dst) return []
    const routes: Route[] = []
    const stationsSeen = new Set<string>()
    for (const [minutes, path] of this.kShortest(src, dst, maxRoutes * 4)) {
      const described = this.describe(minutes, path)
      if (!described) continue
      const key = described.route.join("|")
      if (stationsSeen.has(key)) continue
      if (routes.length && minutes > routes[0]!.minutes! * 1.5 + 10) break
      stationsSeen.add(key)
      routes.push(described)
      if (routes.length === maxRoutes) break
    }
    return routes
  }

  /** Track between two neighbouring stations, in the direction a -> b. */
  segmentGeometry(line: string, a: string, b: string): [number, number][] {
    const forward = this.geometry.get(segKey(line, a, b))
    if (forward) return forward
    return [...this.geometry.get(segKey(line, b, a))!].reverse()
  }

  /** A whole line's track, first station to last. */
  lineGeometry(line: LineData): [number, number][] {
    const out: [number, number][] = []
    for (const [a, b] of zip(line.stations)) {
      const piece = this.segmentGeometry(line.id, a, b)
      const additions = out.length ? piece.slice(1) : piece
      for (const point of additions) out.push(point)
    }
    return out
  }

  resolve(name: string): string | null {
    return this.lookup.get((name ?? "").trim().toLowerCase()) ?? null
  }

  /** None when either station isn't open: no fare is published for it yet. */
  fare(source: string, destination: string): number | null {
    if (this.status.get(source) !== OPERATIONAL) return null
    if (this.status.get(destination) !== OPERATIONAL) return null
    return this.fares[source]?.[destination] ?? null
  }
}

// ---------------------------------------------------------------- singleton + module helpers

const data = networkData as unknown as NetworkData
export const NETWORK = new Network(data)

/** Line names and station orders as the rest of the app expects them. */
export const LINE_NAMES: string[] = NETWORK.lines.map((line) => line.name)
export const LINES: string[][] = NETWORK.lines.map((line) => line.stations)

/** Every line with its track geometry, for drawing the network on a map. */
export function getLineGeometries() {
  return NETWORK.lines.map((line) => ({
    id: line.id,
    name: line.name,
    status: line.status,
    stations: line.stations,
    geometry: NETWORK.lineGeometry(line),
  }))
}

/**
 * Stations of a journey that aren't open, and that matter to the rider: the start and end, and
 * every stop on a line still being built. A closed station the train only passes through
 * (Sabarmati, on a Red Line trip) doesn't count.
 */
export function journeyNotOpen(result: Route): Record<string, string> {
  const building = new Set(NETWORK.lines.filter((line) => line.status === WORK_IN_PROGRESS).map((line) => line.name))
  const route = result.route
  const used = new Set([route[0]!, route[route.length - 1]!])
  for (const leg of result.legs) {
    if (!building.has(leg.line)) continue
    const i = route.indexOf(leg.from)
    const j = route.indexOf(leg.to)
    for (const station of route.slice(i, j + 1)) used.add(station)
  }
  const out: Record<string, string> = {}
  for (const s of route) {
    if (used.has(s) && !isOperational(s)) out[s] = stationStatus(s)
  }
  return out
}

export function stationStatus(name: string): string {
  return NETWORK.status.get(name) ?? OPERATIONAL
}

export function isOperational(name: string): boolean {
  return stationStatus(name) === OPERATIONAL
}

export function getAllStations(): string[] {
  return [...NETWORK.coords.keys()].sort()
}

export function resolveStation(name: string): string | null {
  return NETWORK.resolve(name)
}

export function getFare(source: string, destination: string): number | null {
  return NETWORK.fare(source, destination)
}

function empty(error: string): Route {
  return {
    route: [],
    legs: [],
    interchanges: [],
    distance: 0,
    minutes: null,
    geometry: [],
    instructions: [],
    error,
  }
}

/** Up to `maxRoutes` different routes, quickest first. Slower alternatives are kept only when
 * they are reasonable (at most 50% plus 10 minutes slower than the quickest). */
export function findRoutes(source: string, destination: string, maxRoutes: number = 3): Route[] {
  return NETWORK.findRoutes(source, destination, maxRoutes)
}

/** The quickest route, with `alternatives` (other reasonable routes, quickest first). */
export function calculateRouteDetails(source: string, destination: string): Route {
  const src = resolveStation(source)
  const dst = resolveStation(destination)
  if (!src) return empty(`Station '${source}' not found`)
  if (!dst) return empty(`Station '${destination}' not found`)
  if (src === dst) return empty("Source and destination cannot be the same")
  for (const name of [src, dst]) {
    if (stationStatus(name) === UNDER_CONSTRUCTION) {
      return empty(`${name} station is under construction and not open yet`)
    }
  }
  const routes = NETWORK.findRoutes(src, dst)
  if (!routes.length) return empty("No route found between these stations")
  const best: Route = { ...routes[0]! }
  best.alternatives = routes.slice(1)
  best.not_operational = journeyNotOpen(best)
  return best
}
