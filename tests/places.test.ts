// @vitest-environment node
/**
 * The Google Places proxy for the Nearest Stations search: Google is only called within the limits and the
 * monthly budget, never without a key or a lasting store, and details only for places the autocomplete
 * offered. fetch is mocked; nothing here reaches Google.
 */
import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GET as autocompleteRoute } from "@/app/api/places/autocomplete/route"
import { GET as detailsRoute } from "@/app/api/places/details/route"
import { LIMITS, billingPeriod, monthlyBudget } from "@/server/places"
import { MemoryStore, setStore, store } from "@/server/store"

const SESSION = "0b6f5a3e-2c1d-4e8f-9a7b-1c2d3e4f5a6b"
const PLACE = "ChIJabcdefghijklmnop"

const autocompleteBody = {
  suggestions: [
    {
      placePrediction: {
        placeId: PLACE,
        text: { text: "Law Garden, Ellisbridge, Ahmedabad" },
        structuredFormat: { mainText: { text: "Law Garden" } },
      },
    },
  ],
}

const req = (url: string, headers: Record<string, string> = {}, ip = "1.2.3.4") =>
  new NextRequest(`http://test${url}`, { headers: { "x-forwarded-for": ip, ...headers } })
const suggest = (q = "law garden", ip?: string, session = SESSION) =>
  autocompleteRoute(req(`/api/places/autocomplete?q=${encodeURIComponent(q)}&session=${session}&lang=en`, {}, ip))
const details = (id = PLACE, session = SESSION) => detailsRoute(req(`/api/places/details?id=${id}&session=${session}`))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  setStore(new MemoryStore())
  vi.stubEnv("MAPS_API_KEY", "test-key")
  vi.stubEnv("PLACES_ALLOW_MEMORY_STORE", "1")
  fetchMock = vi.fn(async (url: string) =>
    Response.json(
      String(url).includes(":autocomplete") ? autocompleteBody : { location: { latitude: 23.0249, longitude: 72.563 } },
    ),
  )
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("places autocomplete", () => {
  it("returns Google suggestions, with the key only in the server's request", async () => {
    const body = await (await suggest()).json()
    expect(body).toEqual({
      source: "google",
      suggestions: [{ id: PLACE, name: "Law Garden", address: "Law Garden, Ellisbridge, Ahmedabad" }],
    })
    expect(JSON.stringify(body)).not.toContain("test-key")
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://places.googleapis.com/v1/places:autocomplete")
    expect(init.headers["X-Goog-Api-Key"]).toBe("test-key")
    expect(JSON.parse(init.body)).toMatchObject({ input: "law garden", sessionToken: SESSION, includedRegionCodes: ["in"] })
  })

  it("rejects bad input and other sites without calling Google", async () => {
    expect((await suggest("ab")).status).toBe(400)
    expect((await suggest("x".repeat(101))).status).toBe(400)
    expect((await suggest("law garden", undefined, "not-a-uuid")).status).toBe(400)
    const cross = await autocompleteRoute(
      req(`/api/places/autocomplete?q=law&session=${SESSION}`, { "sec-fetch-site": "cross-site" }),
    )
    expect(cross.status).toBe(403)
    const otherOrigin = await autocompleteRoute(
      req(`/api/places/autocomplete?q=law&session=${SESSION}`, { origin: "https://evil.example" }),
    )
    expect(otherOrigin.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("falls back without a key, or without a store that outlives restarts", async () => {
    vi.stubEnv("MAPS_API_KEY", "")
    expect(await (await suggest()).json()).toEqual({ source: "fallback", reason: "disabled" })
    vi.stubEnv("MAPS_API_KEY", "test-key")
    vi.stubEnv("PLACES_ALLOW_MEMORY_STORE", "")
    expect(await (await suggest()).json()).toEqual({ source: "fallback", reason: "disabled" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("limits each client per minute", async () => {
    for (let i = 0; i < LIMITS.autocomplete.ipMinute; i++) expect((await (await suggest()).json()).source).toBe("google")
    expect(await (await suggest()).json()).toEqual({ source: "fallback", reason: "limited" })
    expect((await (await suggest("law garden", "5.6.7.8")).json()).source).toBe("google")
    expect(fetchMock).toHaveBeenCalledTimes(LIMITS.autocomplete.ipMinute + 1)
  })

  it("stops at 80% of the free monthly usage, and never goes over", async () => {
    expect(monthlyBudget()).toBe(8000)
    vi.stubEnv("PLACES_MONTHLY_BUDGET", "99999") // can only lower it
    expect(monthlyBudget()).toBe(8000)
    const { month } = billingPeriod()
    await store().set(`places:month:${month}:autocomplete`, 7999)
    expect((await (await suggest()).json()).source).toBe("google")
    expect(await (await suggest()).json()).toEqual({ source: "fallback", reason: "budget" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("has a global daily cap", async () => {
    const { day } = billingPeriod()
    await store().set(`places:day:${day}:autocomplete`, LIMITS.autocomplete.globalDay)
    expect(await (await suggest()).json()).toEqual({ source: "fallback", reason: "budget" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("falls back when the store can't count", async () => {
    const broken = new MemoryStore()
    broken.incr = async () => null as unknown as number
    setStore(broken)
    expect(await (await suggest()).json()).toEqual({ source: "fallback", reason: "error" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("falls back when Google fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("denied", { status: 403 }))
    expect(await (await suggest()).json()).toEqual({ source: "fallback", reason: "error" })
  })
})

describe("places details", () => {
  it("only looks up a place offered in the same session, once, with the location field only", async () => {
    expect((await details()).status).toBe(404) // nothing offered yet
    await suggest()
    expect((await details(PLACE, "11111111-2222-4333-8444-555555555555")).status).toBe(404)
    expect((await details("ChIJsomethingelse123")).status).toBe(404)

    expect(await (await details()).json()).toEqual({ latitude: 23.0249, longitude: 72.563 })
    const [url, init] = fetchMock.mock.calls[1]!
    expect(url).toBe(`https://places.googleapis.com/v1/places/${PLACE}?sessionToken=${SESSION}`)
    expect(init.headers["X-Goog-FieldMask"]).toBe("location")
    expect((await details()).status).toBe(404) // the session is over
  })

  it("reuses a cached location without calling Google again", async () => {
    await suggest()
    await details()
    await suggest()
    expect(await (await details()).json()).toEqual({ latitude: 23.0249, longitude: 72.563 })
    expect(fetchMock.mock.calls.filter(([url]) => !String(url).includes(":autocomplete"))).toHaveLength(1)
  })

  it("rejects malformed ids", async () => {
    expect((await details("../../etc")).status).toBe(400)
  })
})
