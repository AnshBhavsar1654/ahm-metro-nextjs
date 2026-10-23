/**
 * Google Maps link parsing (golden, offline) and nearby stations (deterministic, via a stubbed
 * routing service). The live router data shifts over time, so the captured nearby fixture is only
 * sanity-checked, not compared field-for-field.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NETWORK } from "@/domain/metro/network"
import { extractCoordinatesFromUrl, getNearbyStationsData, resolveGoogleMapsUrl } from "@/domain/metro/locations"
import { pyRound } from "@/domain/metro/rounding"

const GOLDEN = path.resolve(import.meta.dirname, "fixtures", "golden")
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- golden fixtures are compared as opaque JSON
const load = (name: string): any => JSON.parse(readFileSync(path.join(GOLDEN, name), "utf8"))

describe("google maps link parsing (golden)", () => {
  it("resolves coordinates embedded in the link without any request", async () => {
    const urls = load("google-maps-coords.json") as Record<string, string>
    const resolved = load("google-maps-resolved.json") as Record<string, unknown>
    for (const [key, url] of Object.entries(urls)) {
      await expect(resolveGoogleMapsUrl(url), key).resolves.toEqual(resolved[key])
    }
  })

  it("rejects empty and non-Maps links with the same messages", async () => {
    await expect(resolveGoogleMapsUrl("  ")).rejects.toThrow("Missing Google Maps URL")
    await expect(resolveGoogleMapsUrl("ftp://maps.app.goo.gl/abc")).rejects.toThrow("Please provide a Google Maps link")
    await expect(resolveGoogleMapsUrl("https://evil.example.com/maps/@23.0225,72.5714")).rejects.toThrow(
      "Please provide a Google Maps link",
    )
  })

  it("extracts coordinates in both !3d/!4d orders", () => {
    expect(extractCoordinatesFromUrl("https://x.test/?ll=23.0225,72.5714")).toEqual([23.0225, 72.5714])
    expect(extractCoordinatesFromUrl("https://x.test/#!3d23.0225!4d72.5714")).toEqual([23.0225, 72.5714])
    expect(extractCoordinatesFromUrl("https://x.test/#!4d72.5714!3d23.0225")).toEqual([23.0225, 72.5714])
  })
})

describe("nearby stations with a stubbed router (port logic, deterministic)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A FOSSGIS-flavoured stub: table for the /table/ call, static geometry for /route/ calls. */
  function stubRouter({ distances, durations }: { distances: (number | null)[]; durations: (number | null)[] }) {
    const geometry: [number, number][] = [
      [72.5714, 23.0225],
      [72.5724, 23.0215],
      [72.5734, 23.0235],
    ]
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/table/v1/")) {
          return {
            ok: true,
            json: async () => ({
              // OSRM matrix shape: one row per source; sources=0 gives a single row covering every
              // destination, first cell being the source itself.
              distances: [[null, ...distances]],
              durations: [[null, ...durations]],
            }),
          }
        }
        return { ok: true, json: async () => ({ routes: [{ geometry: { coordinates: geometry } }] }) }
      }),
    )
    return geometry
  }

  it("walk router answers: distances in km, walking minutes, real paths", async () => {
    const geometry = stubRouter({
      distances: [1500, 2200, 3000, 900, 5000, 2100, 3300, 4400],
      durations: [1080, 1440, 2100, 600, 3000, 1500, 2400, 3000],
    })
    const nearby = await getNearbyStationsData(23.0225, 72.5714)

    expect(nearby).toHaveLength(3)
    // 0.9 km and 1.5 km are the two nearest; 2.1 and 2.2 tie -> stable straight-line sort decides.
    expect(nearby.map((s) => s.distance)).toEqual([pyRound(0.9, 1), pyRound(1.5, 1), pyRound(2.1, 1)])
    expect(nearby.map((s) => s.distance_type)).toEqual(["walk", "walk", "walk"])
    expect(nearby.map((s) => s.walk_minutes)).toEqual([pyRound(10), pyRound(18), pyRound(25)])
    // Every path starts at the rider and ends exactly at the station's own coordinates.
    for (const station of nearby) {
      expect(station.path![0]).toEqual([23.0225, 72.5714])
      expect(station.path!.at(-1)).toEqual([
        nearbyStationCoords(station.name).latitude,
        nearbyStationCoords(station.name).longitude,
      ])
      const middle = station.path!.slice(1, -1)
      expect(middle).toEqual(geometry.map(([lng, lat]) => [pyRound(lat, 6), pyRound(lng, 6)]))
    }
  })

  it("road fallback when the walking router is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("routing.openstreetmap.de")) return { ok: false, json: async () => ({}) }
        return {
          ok: true,
          json: async () => ({
            distances: [[null, 800, 6100, 4000, 2500, 3500, 1200, 4800, 5200]],
            durations: [[null, 90, 700, 450, 280, 400, 140, 550, 600]],
          }),
        }
      }),
    )
    const nearby = await getNearbyStationsData(23.0225, 72.5714)
    expect(nearby).toHaveLength(3)
    expect(nearby.map((s) => s.distance)).toEqual([pyRound(0.8, 1), pyRound(1.2, 1), pyRound(2.5, 1)])
    expect(nearby.map((s) => s.distance_type)).toEqual(["road", "road", "road"])
    // road distance never claims walking minutes
    expect(nearby.map((s) => s.walk_minutes)).toEqual([null, null, null])
  })

  it("no router answers at all: straight-line distances, straight paths", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    )
    const nearby = await getNearbyStationsData(23.0225, 72.5714)
    expect(nearby).toHaveLength(3)
    expect(nearby.map((s) => s.distance_type)).toEqual(["straight", "straight", "straight"])
    expect(nearby.map((s) => s.walk_minutes)).toEqual([null, null, null])
    for (const station of nearby) {
      // No router backend: the map draws a straight line itself, so no path comes back.
      expect(station.path).toBeNull()
    }
  })

  it("shortlists by straight line, then rejects bad input like the backend", async () => {
    stubRouter({
      distances: [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000],
      durations: [600, 1200, 1800, 2400, 3000, 3600, 4200, 4800],
    })
    await expect(getNearbyStationsData(null, 72.5714)).rejects.toThrow("Missing latitude/longitude parameters")
    await expect(getNearbyStationsData(23.0225, null)).rejects.toThrow("Missing latitude/longitude parameters")
    await expect(getNearbyStationsData(95, 72.5714)).rejects.toThrow("Invalid coordinates")
    await expect(getNearbyStationsData(23.0225, 200)).rejects.toThrow("Invalid coordinates")
  })
})

/** The captured fixture proves the same shape is what the real backend produced. */
describe("captured nearby fixture (structure only — live router data shifts)", () => {
  it("three nearest, sane fields", () => {
    const golden = load("nearby.json") as { distance: number; distance_type: string; walk_minutes: unknown; path: unknown }[]
    expect(golden).toHaveLength(3)
    for (const s of golden) {
      expect(s.distance).toEqual(expect.any(Number))
      expect(["walk", "road", "straight"]).toContain(s.distance_type)
      expect(
        s.path === null ||
          (Array.isArray(s.path) && s.path.every(([lat, lng]) => typeof lat === "number" && typeof lng === "number")),
      ).toBe(true)
    }
  })
})

function nearbyStationCoords(name: string): { latitude: number; longitude: number } {
  const [latitude, longitude] = NETWORK.coords.get(name)!
  return { latitude, longitude }
}
