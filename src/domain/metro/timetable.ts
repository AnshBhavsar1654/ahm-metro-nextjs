/**
 * Travel times and next trains, from GMRC's published timetable (src/data/timetable.json,
 * w.e.f. 18 May 2026) — the 1:1 TypeScript port of backend/metro/timetable.py.
 *
 * The timetable lists only the through trains between APMC and Mahatma Mandir / GIFT City, at
 * nine timing points. From it we take:
 * - running times per segment (computed by build_network.py and stored in network.json);
 * - departures for every station on that corridor: exact at timing points, interpolated
 *   ("approx") elsewhere.
 * The Blue Line is not in the timetable; its running time is an approximation (about 45 min
 * end to end).
 *
 * `now` is passed by the caller as { hour, minute } in Ahmedabad time — see istNow() — so every
 * output is deterministic and the golden tests can pin it.
 */
import { NETWORK, calculateRouteDetails } from "./network"
import { pyRoundInt, pySum } from "./rounding"
import networkJson from "@/data/network.json"
import timetableJson from "@/data/timetable.json"

export const TRANSFER_MINUTES = NETWORK.transferMinutes // walking between platforms plus a typical wait
export const SOURCE = "GMRC timetable w.e.f. 18 May 2026"

/** A wall-clock time in Ahmedabad (IST) the caller wants to know "next trains from" — as { hour, minute }. */
export type StationTime = { hour: number; minute: number }

export type JourneyLeg = { line: string; from: string; to: string; stops?: number }

/** The current time in Ahmedabad, as { hour, minute } — the runtime twin of datetime.now(IST). */
export function istNow(date: Date = new Date()): StationTime {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const hour = Number(parts.find((p) => p.type === "hour")!.value)
  const minute = Number(parts.find((p) => p.type === "minute")!.value)
  return { hour, minute }
}

type TrainStop = [station: string, hhmm: string]
type Train = { direction: string; stops: TrainStop[] }
type TrainCall = [station: string, minute: number, approximate: boolean]

const TRAINS: Train[] = (timetableJson as unknown as { trains: Train[] }).trains
const SEGMENTS: { line: string; from: string; to: string; minutes: number }[] = (
  networkJson as unknown as { segments: { line: string; from: string; to: string; minutes: number }[] }
).segments

const zip = <T>(items: T[]): [T, T][] => {
  const pairs: [T, T][] = []
  for (let i = 0; i + 1 < items.length; i++) pairs.push([items[i]!, items[i + 1]!])
  return pairs
}

const minutesOfDay = (hhmm: string): number => {
  const [h, m] = hhmm.split(":")
  return Number(h) * 60 + Number(m)
}

/** "07:32" style clock text, wrapping around midnight. */
const clock = (minutes: number): string => {
  const minuteOfDay = pyRoundInt(minutes) % (24 * 60)
  return `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`
}

// ---------------------------------------------------------------- running times

/**
 * Minutes from each line's first station, from the segment running times in network.json
 * (build_network.py derives them from this same timetable; the Blue Line is an approximation).
 */
export const LINE_MINUTES: Map<string, Map<string, number>> = new Map()
for (const line of NETWORK.lines) {
  const minutesBySegment = new Map<string, number>(
    SEGMENTS.filter((seg) => seg.line === line.id).map((seg) => [`${seg.from}\u0000${seg.to}`, seg.minutes] as const),
  )
  let total = 0
  const cumulative = new Map<string, number>()
  line.stations.forEach((station, i) => {
    if (i) {
      const minutes = minutesBySegment.get(`${line.stations[i - 1]}\u0000${station}`)
      if (minutes === undefined) throw new Error(`timetable: no segment ${line.id} ${line.stations[i - 1]} -> ${station}`)
      total += minutes
    }
    cumulative.set(station, total)
  })
  LINE_MINUTES.set(line.name, cumulative)
}

// ---------------------------------------------------------------- next trains

/** (station, minutes after midnight, approximate?) for every station the train passes. */
function trainTimes(train: Train): TrainCall[] {
  const stops = train.stops
  const path = calculateRouteDetails(stops[0]![0], stops[stops.length - 1]![0]).route
  const known = new Map(stops.map(([name, t]) => [name, minutesOfDay(t)] as const))
  const index = path.map((s, i) => (known.has(s) ? i : -1)).filter((i) => i >= 0)
  const out: TrainCall[] = []
  for (const [i, j] of zip(index)) {
    const ti = known.get(path[i]!)!
    const tj = known.get(path[j]!)!
    for (let k = i; k < j; k++) {
      out.push([path[k]!, ti + ((tj - ti) * (k - i)) / (j - i), k !== i])
    }
  }
  const lastKnown = path[index[index.length - 1]!]!
  out.push([lastKnown, known.get(lastKnown)!, false])
  return out
}

const SCHEDULE: { direction: string; destination: string; times: TrainCall[] }[] = TRAINS.map((train) => ({
  direction: train.direction,
  destination: train.stops[train.stops.length - 1]![0],
  times: trainTimes(train),
}))

export const CORRIDOR_STATIONS: Set<string> = new Set(SCHEDULE.flatMap((train) => train.times.map(([name]) => name)))

export type DepartureRow = { time: string; destination: string; approx: boolean }

/** Next through trains from `station` in each direction, or null if no timetabled train calls there. */
export function departures(
  station: string,
  now: StationTime = istNow(),
  perDirection: number = 3,
): {
  station: string
  directions: { towards: string; trains: DepartureRow[]; first: string; last: string }[]
  source: string
} | null {
  if (!CORRIDOR_STATIONS.has(station)) return null
  const nowMinutes = now.hour * 60 + now.minute
  const groups = new Map<string, (DepartureRow & { minutes: number })[]>()
  const first = new Map<string, number>()
  const last = new Map<string, number>()
  for (const train of SCHEDULE) {
    for (const [name, minute, approx] of train.times) {
      if (name !== station || name === train.destination) continue
      const direction = train.direction
      first.set(direction, Math.min(first.get(direction) ?? minute, minute))
      last.set(direction, Math.max(last.get(direction) ?? minute, minute))
      if (minute >= nowMinutes) {
        if (!groups.has(direction)) groups.set(direction, [])
        groups.get(direction)!.push({ time: clock(minute), destination: train.destination, approx, minutes: minute })
      }
    }
  }
  const directions: { towards: string; trains: DepartureRow[]; first: string; last: string }[] = []
  for (const direction of ["up", "down"]) {
    if (!first.has(direction)) continue
    const trains = (groups.get(direction) ?? [])
      .slice()
      .sort((a, b) => a.minutes - b.minutes)
      .slice(0, perDirection)
      .map(({ time, destination, approx }) => ({ time, destination, approx }))
    directions.push({
      towards: direction === "up" ? "Mahatma Mandir / GIFT City" : "APMC",
      trains,
      first: clock(first.get(direction)!),
      last: clock(last.get(direction)!),
    })
  }
  return { station, directions, source: SOURCE }
}

// ---------------------------------------------------------------- journey time

/** True if some timetabled train calls at a and then b, so a change of line there needs no change of train. */
function throughTrain(a: string, b: string): boolean {
  for (const train of SCHEDULE) {
    const names = train.times.map(([name]) => name)
    if (names.includes(a) && names.includes(b) && names.indexOf(a) < names.indexOf(b)) return true
  }
  return false
}

/** Estimated time on the train, plus TRANSFER_MINUTES for each change that needs a different train. */
export function journeyMinutes(legs: JourneyLeg[]): number {
  // Python: ride = sum(abs(...) for leg in legs) — builtins use compensated summation for floats.
  const ride = pySum(
    legs.map((leg) => {
      const lineMinutes = LINE_MINUTES.get(leg.line)!
      return Math.abs(lineMinutes.get(leg.to)! - lineMinutes.get(leg.from)!)
    }),
  )
  let changes = 0
  for (const [first, second] of zip(legs)) {
    if (!throughTrain(first.from, second.to)) changes++
  }
  return pyRoundInt(ride + TRANSFER_MINUTES * changes)
}

/** True if the whole journey can be made without changing trains (it spans several lines). */
export function throughService(legs: JourneyLeg[]): boolean {
  return legs.length > 1 && throughTrain(legs[0]!.from, legs[legs.length - 1]!.to)
}

// ---------------------------------------------------------------- next trains for a journey

const INFREQUENT_LINES = new Set(["Yellow Line", "Violet Line"]) // served only by the timetabled through trains

export type JourneyTrainsResult = {
  board_at: string
  towards: string
  trains: DepartureRow[]
  first: string
  last: string
  source: string
}

/**
 * For a journey onto the Yellow or Violet Line: where to catch a timetabled train, and the next ones
 * that actually reach the end of that leg. null for journeys those lines aren't part of.
 */
export function journeyTrains(legs: JourneyLeg[], now: StationTime = istNow(), limit: number = 3): JourneyTrainsResult | null {
  const k = legs.findIndex((leg) => INFREQUENT_LINES.has(leg.line))
  if (k === -1) return null
  const target = legs[k]!.to
  let board = legs[k]!.from
  let j = k
  while (j > 0 && throughTrain(legs[j - 1]!.from, target)) {
    j--
    board = legs[j]!.from
  }

  const nowMinutes = now.hour * 60 + now.minute
  const calls: [number, string, boolean][] = []
  for (const train of SCHEDULE) {
    const names = train.times.map(([name]) => name)
    if (names.includes(board) && names.includes(target) && names.indexOf(board) < names.indexOf(target)) {
      const [, minute, approx] = train.times[names.indexOf(board)]!
      calls.push([minute, train.destination, approx])
    }
  }
  if (!calls.length) return null
  calls.sort(compareCalls)
  const trains = calls
    .filter(([minute]) => minute >= nowMinutes)
    .slice(0, limit)
    .map(([minute, destination, approx]) => ({ time: clock(minute), destination, approx }))
  return {
    board_at: board,
    towards: target,
    trains,
    first: clock(calls[0]![0]),
    last: clock(calls[calls.length - 1]![0]),
    source: SOURCE,
  }
}

/** (minute, destination, approx) — the same tuple order backend's sort() compared. */
const compareCalls = (a: [number, string, boolean], b: [number, string, boolean]): number => {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1 // code-point order, like Python strings
  return Number(a[2]) - Number(b[2]) // false < true
}

/** For each change of line: true if a through train continues onto the next line (no change of train). */
export function stayOnTrain(legs: JourneyLeg[]): boolean[] {
  return zip(legs).map(([first, second]) => throughTrain(first.from, second.to))
}
