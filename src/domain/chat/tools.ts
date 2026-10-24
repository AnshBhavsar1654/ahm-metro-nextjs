/**
 * Tools the agent can call, so fares, routes, timetables, station details and policies come from the
 * app's data — the 1:1 TypeScript port of backend/chatbot/tools.py.
 *
 * Every tool returns an object and never throws: problems go back to the model as { error } so it can
 * tell the rider. The plain functions are exported too: the assistant puts their results in the
 * question up front (one model call instead of a tool round).
 */
import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import { z } from "zod"
import stationData from "@/data/stationData.json"
import { LINES, LINE_NAMES, calculateRouteDetails, getFare, stationStatus } from "@/domain/metro/network"
import { departures, istNow, journeyMinutes, throughService, type StationTime } from "@/domain/metro/timetable"
import { sectionText, search } from "./knowledge"
import { pyJsonDumps } from "./pycompat"
import { findStations } from "./rules"

type Result = Record<string, unknown>

function safe<A extends unknown[]>(name: string, fn: (...args: A) => Result): (...args: A) => Result {
  return (...args: A) => {
    try {
      return fn(...args)
    } catch (exc) {
      // a data bug must not kill the answer
      console.log(`[tools] ${name} failed: ${exc instanceof Error ? exc.message : String(exc)}`)
      return { error: "The lookup failed. Tell the rider to use /routes." }
    }
  }
}

const resolve = (name: unknown): string[] => findStations(String(name ?? ""))

export const getJourney = safe("get_journey", (fromStation: string, toStation: string): Result => {
  const [src, dst] = [resolve(fromStation), resolve(toStation)]
  if (!src.length) return { error: `No station matches '${fromStation}'. Ask the rider which station they mean.` }
  if (!dst.length) return { error: `No station matches '${toStation}'. Ask the rider which station they mean.` }
  const [a, b] = [src[0]!, dst[0]!]
  const result = calculateRouteDetails(a, b)
  if (result.error) return { error: result.error }
  const fare = getFare(a, b)
  const closed = result.not_operational ?? {}
  const anyClosed = Object.keys(closed).length > 0
  return {
    from: a,
    to: b,
    fare_rupees: fare !== null ? fare : anyClosed ? "not published yet (work in progress)" : "not listed",
    stations_not_open: anyClosed ? closed : null, // under construction: trains pass; work in progress: not running yet
    distance_km: result.distance,
    stations_count: result.route.length,
    interchanges: result.interchanges,
    legs: result.legs,
    estimated_minutes: journeyMinutes(result.legs),
    no_change_of_train_needed: throughService(result.legs),
  }
})

export const getLineStations = safe("get_line_stations", (line: string): Result => {
  const wanted = String(line ?? "")
    .toLowerCase()
    .replace("purple", "violet")
  // Longest names first, so "light blue" isn't taken for "blue".
  const pairs = LINE_NAMES.map((name, i) => [name, LINES[i]!] as const).sort((a, b) => b[0].length - a[0].length)
  for (const [name, stops] of pairs) {
    if (wanted.includes(name.toLowerCase().replace(/ line$/, ""))) return { line: name, stations_in_order: stops }
  }
  return { error: `Unknown line '${line}'. Lines are: ${LINE_NAMES.join(", ")}.` }
})

type GateEntry = { name: string; type: string; gates: string[]; facilities: string[] }

// Gates, lifts and elevated/underground per station: the same file the website's /stations-info page shows.
let gates: Map<string, GateEntry> | null = null
export function gateData(): Map<string, GateEntry> {
  if (!gates) {
    gates = new Map()
    for (const entry of stationData as GateEntry[]) {
      const found = findStations(entry.name) // "Old High Court (Interchange)", "Gheekanta"...
      if (found.length) gates.set(found[0]!, entry)
    }
  }
  return gates
}

export const getStationInfo = safe("get_station_info", (station: string): Result => {
  const found = resolve(station)
  if (!found.length) return { error: `No station matches '${station}'.` }
  const name = found[0]!
  const lines = LINE_NAMES.filter((_, i) => LINES[i]!.includes(name))
  const info: Result = { station: name, status: stationStatus(name), lines, is_interchange: lines.length > 1 }
  const entry = gateData().get(name)
  if (entry) Object.assign(info, { type: entry.type, entry_exit_gates: entry.gates, lifts: entry.facilities })
  return info
})

export const getNextTrains = safe("get_next_trains", (station: string, now: StationTime = istNow()): Result => {
  const found = resolve(station)
  if (!found.length) return { error: `No station matches '${station}'.` }
  const name = found[0]!
  if (stationStatus(name) !== "operational") {
    return {
      station: name,
      status: stationStatus(name),
      note: "No trains stop here yet (under construction: trains pass without stopping; work in progress: line not running).",
    }
  }
  const result = departures(name, now)
  if (result === null) {
    return {
      station: name,
      note:
        "This station is not in the published timetable (it covers the APMC to " +
        "Mahatma Mandir / GIFT City trains). Use the train frequency in the knowledge base.",
    }
  }
  return {
    ...result,
    note:
      "Times marked approx are interpolated between timetable points. An empty list means no " +
      "more trains today; 'first' and 'last' are the day's first and last trains.",
  }
})

export const searchKnowledgeBase = safe("search_knowledge_base", (query: string): Result => {
  const found = search(query)
  if (!found.length) return { result: "Nothing in the knowledge base matches. Say you don't have that information." }
  return { sections: found.map(sectionText) }
})

// ---------------------------------------------------------------- LangChain tools (descriptions as in tools.py docstrings)

const station = (what: string) => z.string().describe(`${what}, as the rider wrote it (any language).`)

export const TOOLS: StructuredToolInterface[] = [
  tool(({ from_station, to_station }) => pyJsonDumps(getJourney(from_station, to_station)), {
    name: "get_journey",
    description:
      "Official fare (in rupees), route, line changes, distance and estimated travel time between two metro stations.\n\n" +
      "Use for any fare, route, 'how do I get to', 'how long' or 'how many stations' question.",
    schema: z.object({ from_station: station("Starting station"), to_station: station("Destination station") }),
  }),
  tool(({ line }) => pyJsonDumps(getLineStations(line)), {
    name: "get_line_stations",
    description: "All stations on one metro line, in order.",
    schema: z.object({ line: z.string().describe("Red, Blue, Yellow, Violet, Pink or Light Blue.") }),
  }),
  tool(({ station: name }) => pyJsonDumps(getStationInfo(name)), {
    name: "get_station_info",
    description:
      "A station's lines, whether it is an interchange, whether it is open, elevated or underground, its entry/exit gates and where its lifts are.",
    schema: z.object({ station: z.string().describe("Station name, as the rider wrote it (any language).") }),
  }),
  tool(({ station: name }) => pyJsonDumps(getNextTrains(name)), {
    name: "get_next_trains",
    description:
      "Next timetabled trains from a station in each direction, plus the first and last train of the day.\n\n" +
      "Covers stations on the APMC to Mahatma Mandir / GIFT City trains. Use for 'when is the next train',\n" +
      "'first train' or 'last train' questions.",
    schema: z.object({ station: z.string().describe("Station name, as the rider wrote it (any language).") }),
  }),
  tool(({ query }) => pyJsonDumps(searchKnowledgeBase(query)), {
    name: "search_knowledge_base",
    description:
      "Search the official Ahmedabad Metro knowledge base: tickets, passes, concessions, smart card, NCMC, refunds, penalties, timings, frequency, luggage, facilities, safety, lost and found, contacts.\n\n" +
      "Use whenever the knowledge base excerpts in the rider's message don't answer the question.",
    schema: z.object({
      query: z
        .string()
        .describe('A few English keywords, even if the rider wrote in Gujarati or Hindi (e.g. "student pass concession").'),
    }),
  }),
]
