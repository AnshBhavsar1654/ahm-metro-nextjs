// @vitest-environment node
/**
 * The HTTP layer — the ports of backend/tests' TestClient checks: the metro endpoints, chat streaming
 * and its limits, visits (counter, limit per IP, live stream), keep-alive and the shared store.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { POST as chatStream } from "@/app/api/chat/stream/route"
import { GET as departures } from "@/app/api/departures/route"
import { POST as fare } from "@/app/api/fare/route"
import { GET as faresFrom } from "@/app/api/fares/from/route"
import { GET as lines } from "@/app/api/lines/route"
import { POST as resolveMaps } from "@/app/api/location/resolve-google-maps/route"
import { POST as route } from "@/app/api/route/route"
import { GET as nearby } from "@/app/api/stations/nearby/route"
import { GET as stations } from "@/app/api/stations/route"
import { GET as visitsNow, POST as recordVisit } from "@/app/api/visits/route"
import { active, startKeepalive } from "@/server/keepalive"
import { MemoryStore, setStore } from "@/server/store"
import { MAX_VISITS_PER_IP_PER_HOUR, VisitCounter } from "@/server/visits"

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://test${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  })
const get = (url: string) => new NextRequest(`http://test${url}`)

const sseEvents = async (res: Response) =>
  (await res.text())
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, string>)

const tempFile = () => path.join(mkdtempSync(path.join(tmpdir(), "metro-")), "visits.json")

beforeEach(() => setStore(new MemoryStore()))

describe("metro endpoints", () => {
  it("lists stations and lines", async () => {
    expect(((await stations().json()) as string[]).length).toBe(62)
    const byId = Object.fromEntries(((await lines().json()) as { id: string; status: string }[]).map((l) => [l.id, l.status]))
    expect(byId.red).toBe("operational")
    expect(byId.pink).toBe("work in progress")
  })

  it("returns time and legs for a route, and errors for bad input", async () => {
    const body = (await (await route(post("/api/route", { source: "APMC", destination: "Gift City" }))).json()) as Record<
      string,
      unknown
    >
    expect(body.through_service).toBe(true)
    expect(body.legs).toHaveLength(3)
    expect(body.duration_minutes).toBeGreaterThan(0)
    expect((await route(post("/api/route", { source: " ", destination: "Paldi" }))).status).toBe(400)
    expect((await route(post("/api/route", { source: "Mars", destination: "Paldi" }))).status).toBe(400)
    expect((await route(post("/api/route", { source: 5 }))).status).toBe(422)
    expect((await route(new Request("http://test/api/route", { method: "POST", body: "nope" }))).status).toBe(422)
  })

  it("serves departures and the fare table", async () => {
    expect(((await departures(get("/api/departures?station=gnlu")).json()) as { station: string }).station).toBe("GNLU")
    expect(((await departures(get("/api/departures?station=thaltej")).json()) as { directions: unknown[] }).directions).toEqual(
      [],
    )
    expect(departures(get("/api/departures?station=mars")).status).toBe(400)
    const fares = (await faresFrom(get("/api/fares/from?station=Paldi")).json()) as { station: string; fare: number | null }[]
    expect(fares).toHaveLength(61)
    expect(fares).toContainEqual({ station: "Thaltej", fare: 15 })
    expect(fares).toContainEqual({ station: "Airport", fare: null }) // work in progress: no fare published yet
  })

  it("treats Sabarmati as work in progress", async () => {
    const res = await route(post("/api/route", { source: "Paldi", destination: "Sabarmati" }))
    expect(((await res.json()) as { not_operational: unknown }).not_operational).toEqual({ Sabarmati: "work in progress" })
    expect(await (await fare(post("/api/fare", { source: "Sabarmati", destination: "Paldi" }))).json()).toEqual({ fare: null })
    expect(await (await fare(post("/api/fare", { source: "Mars", destination: "Paldi" }))).json()).toEqual({
      error: "Unknown source or destination station",
    })
    expect(((await departures(get("/api/departures?station=Sabarmati")).json()) as { directions: unknown[] }).directions).toEqual(
      [],
    )
  })

  it.each(["https://evil-google.com/maps", "http://127.0.0.1:5000/", "https://google.com.evil.io/x", "file:///etc/passwd"])(
    "rejects a maps link to %s",
    async (url) => {
      expect((await resolveMaps(post("/api/location/resolve-google-maps", { url }))).status).toBe(400)
    },
  )

  it("reads coordinates from a maps link", async () => {
    const res = await resolveMaps(
      post("/api/location/resolve-google-maps", { url: "https://www.google.com/maps/place/X/@23.02,72.57,15z" }),
    )
    expect(((await res.json()) as { latitude: number }).latitude).toBe(23.02)
  })

  it("validates nearby-station coordinates", async () => {
    expect((await nearby(get("/api/stations/nearby"))).status).toBe(400)
    expect((await nearby(get("/api/stations/nearby?lat=abc&lng=72.5"))).status).toBe(422)
    expect((await nearby(get("/api/stations/nearby?lat=123&lng=72.5"))).status).toBe(400)
  })
})

describe("chat endpoint", () => {
  const key = process.env.GEMINI_API_KEY
  afterEach(() => {
    if (key === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = key
    delete process.env.CHAT_LIMIT_PER_MINUTE
  })

  it("validates input", async () => {
    expect((await chatStream(post("/api/chat/stream", { message: "  " }))).status).toBe(400)
    expect((await chatStream(post("/api/chat/stream", { message: "x".repeat(1001) }))).status).toBe(400)
    expect((await chatStream(post("/api/chat/stream", { message: "hi", history: "nope" }))).status).toBe(422)
  })

  it("answers rules questions without a key, as server-sent events", async () => {
    delete process.env.GEMINI_API_KEY
    const res = await chatStream(post("/api/chat/stream", { message: "fare from paldi to thaltej" }))
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/)
    const events = await sseEvents(res)
    expect(events[0]!.text).toContain("₹15")
    expect(events.at(-1)).toEqual({ type: "done", source: "rules" })
  })

  it("reports a failure before the first piece with a status code", async () => {
    delete process.env.GEMINI_API_KEY
    const res = await chatStream(post("/api/chat/stream", { message: "what is the refund policy" }))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toContain("isn't set up")
  })

  it("limits each client per minute", async () => {
    process.env.CHAT_LIMIT_PER_MINUTE = "2"
    const ask = (ip: string) => chatStream(post("/api/chat/stream", { message: "hello" }, { "x-forwarded-for": ip }))
    const codes = []
    for (let i = 0; i < 3; i++) codes.push((await ask("203.0.113.9")).status)
    expect(codes).toEqual([200, 200, 429])
    expect((await ask("203.0.113.10")).status).toBe(200)
  })
})

describe("visits", () => {
  it("counts, persists to the file without Redis, and limits per IP", async () => {
    const file = tempFile()
    const c = new VisitCounter(new MemoryStore(), file)
    expect((await c.snapshot()).total).toBe(0)
    for (let i = 0; i < MAX_VISITS_PER_IP_PER_HOUR + 3; i++) await c.record("203.0.113.1")
    await c.record("203.0.113.2")
    expect((await c.snapshot()).total).toBe(MAX_VISITS_PER_IP_PER_HOUR + 1) // one IP can't inflate the count
    expect((await new VisitCounter(new MemoryStore(), file).snapshot()).total).toBe(MAX_VISITS_PER_IP_PER_HOUR + 1) // survives a restart
  })

  it("streams who is online and new visits, and lets go when the visitor leaves", async () => {
    const c = new VisitCounter(new MemoryStore(), tempFile())
    const left = new AbortController()
    const stream = c.stream(left.signal)
    expect((await stream.next()).value).toEqual({ total: 0, online: 1 })
    await c.record("198.51.100.7")
    expect((await stream.next()).value).toEqual({ total: 1, online: 1 })
    const waiting = stream.next()
    left.abort()
    expect((await waiting).done).toBe(true)
    expect((await c.snapshot()).online).toBe(0)
  })

  it("serves the endpoints", async () => {
    process.env.VISITS_FILE = tempFile() // don't touch the real count (the counter is created on first use)
    const before = ((await (await visitsNow()).json()) as { total: number }).total
    const after = (await (await recordVisit(post("/api/visits", {}, { "x-forwarded-for": "192.0.2.44" }))).json()) as {
      total: number
    }
    expect(after.total).toBe(before + 1)
  })
})

describe("keep-alive", () => {
  afterEach(() => {
    for (const name of ["KEEPALIVE_START_HOUR", "KEEPALIVE_END_HOUR", "RENDER_EXTERNAL_URL", "KEEPALIVE_URL"])
      delete process.env[name]
  })

  it("does nothing without a URL", () => {
    startKeepalive()() // returns a no-op stop function and starts no timer
  })

  it.each([
    [5, false],
    [6, true],
    [22, true],
    [23, false],
  ])("is active at %i:00 IST: %s", (hour, expected) => {
    expect(active({ hour, minute: 0 })).toBe(expected)
  })

  it("takes the window from the environment", () => {
    process.env.KEEPALIVE_START_HOUR = "8"
    process.env.KEEPALIVE_END_HOUR = "20"
    expect(active({ hour: 7, minute: 0 })).toBe(false)
    expect(active({ hour: 19, minute: 0 })).toBe(true)
    process.env.KEEPALIVE_START_HOUR = "not-a-number"
    expect(active({ hour: 6, minute: 0 })).toBe(true) // falls back to 6
  })
})

describe("memory store", () => {
  it("expires values and keeps a sliding window per key", async () => {
    const s = new MemoryStore()
    await s.set("a", "x", 0.05)
    expect(await s.get("a")).toBe("x")
    await new Promise((r) => setTimeout(r, 80))
    expect(await s.get("a")).toBeNull()
    expect([await s.hit("k", 60, 2), await s.hit("k", 60, 2), await s.hit("k", 60, 2)]).toEqual([true, true, false])
    expect(await s.incr("n")).toBe(1)
    expect(await s.incr("n")).toBe(2)
    await s.touch("online", "m1", 60)
    await s.touch("online", "m2", 0.01)
    await new Promise((r) => setTimeout(r, 30))
    expect(await s.alive("online")).toBe(1)
  })
})
