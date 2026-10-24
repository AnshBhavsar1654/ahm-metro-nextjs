// @vitest-environment node
/**
 * Golden parity: the TypeScript chatbot (rules, retrieval, tools, prompt assembly) against the real
 * outputs of backend/chatbot, captured by scripts/capture-golden-chat.py at a fixed IST moment.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { answerWithRules, buildMessages, systemPrompt } from "@/domain/chat/assistant"
import { search } from "@/domain/chat/knowledge"
import { detectIntent, detectLanguage, findStations, normalise } from "@/domain/chat/rules"
import { gateData, getJourney, getLineStations, getNextTrains, getStationInfo } from "@/domain/chat/tools"

const GOLDEN = path.resolve(import.meta.dirname, "fixtures", "golden")
const load = <T>(name: string): T => JSON.parse(readFileSync(path.join(GOLDEN, name), "utf8")) as T

/** 2026-07-01 10:30 in Ahmedabad (a Wednesday), the moment the fixtures were captured at. */
const NOW_DATE = new Date("2026-07-01T05:00:00Z")
const NOW = { hour: 10, minute: 30 }

type Understanding = { language: string; stations: string[]; intent: string | null; normalised: string; rules: string | null }

describe("golden parity: chatbot rules", () => {
  const cases = load<Record<string, Understanding>>("chat-rules.json")

  it("understands every message as the backend did (language, stations, intent)", () => {
    const mismatches: string[] = []
    for (const [message, want] of Object.entries(cases)) {
      const stations = findStations(message)
      const got = {
        language: detectLanguage(message),
        stations,
        intent: detectIntent(message, stations),
        normalised: normalise(message),
      }
      const expected = { language: want.language, stations: want.stations, intent: want.intent, normalised: want.normalised }
      if (JSON.stringify(got) !== JSON.stringify(expected))
        mismatches.push(`${message}: ${JSON.stringify(got)} != ${JSON.stringify(expected)}`)
    }
    expect(mismatches).toEqual([])
    expect(Object.keys(cases).length).toBeGreaterThan(1500)
  })

  it("gives every instant answer word for word", () => {
    const mismatches = Object.entries(cases).filter(([message, want]) => answerWithRules(message, []) !== want.rules)
    expect(mismatches.map(([m]) => m)).toEqual([])
  })

  it("completes follow-ups from the history and assembles the same model messages", () => {
    type Case = { history: unknown[]; message: string; rules: string | null; messages: { role: string; content: string }[] }
    for (const c of load<Case[]>("chat-history.json")) {
      expect(answerWithRules(c.message, c.history), c.message).toBe(c.rules)
      expect(buildMessages(c.message, c.history, NOW_DATE), c.message).toEqual(c.messages)
    }
  })
})

describe("golden parity: retrieval, tools and prompt", () => {
  it("retrieves the same knowledge-base sections, best first", () => {
    for (const [query, titles] of Object.entries(load<Record<string, string[]>>("chat-knowledge.json"))) {
      expect(
        search(query).map((s) => s.title),
        query,
      ).toEqual(titles)
    }
  })

  it("tools return what the Python tools returned", () => {
    type Tools = {
      station_info: Record<string, unknown>
      next_trains: Record<string, unknown>
      line_stations: Record<string, unknown>
      journey: Record<string, unknown>
      gate_count: number
    }
    const golden = load<Tools>("chat-tools.json")
    for (const [station, want] of Object.entries(golden.station_info)) expect(getStationInfo(station), station).toEqual(want)
    for (const [station, want] of Object.entries(golden.next_trains)) expect(getNextTrains(station, NOW), station).toEqual(want)
    for (const [line, want] of Object.entries(golden.line_stations)) expect(getLineStations(line), line).toEqual(want)
    for (const [pair, want] of Object.entries(golden.journey)) {
      const [from, to] = pair.split("|") as [string, string]
      expect(getJourney(from, to), pair).toEqual(want)
    }
    expect(gateData().size).toBe(golden.gate_count)
  })

  it("builds the same system prompt and the same rider turn (facts, timetable, excerpts, time)", () => {
    const golden = load<{ system: string; turns: Record<string, string> }>("chat-prompt.json")
    expect(systemPrompt()).toBe(golden.system)
    for (const [message, turn] of Object.entries(golden.turns)) {
      expect(buildMessages(message, [], NOW_DATE).at(-1)!.content, message).toBe(turn)
    }
  })
})
