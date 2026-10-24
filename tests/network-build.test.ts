// @vitest-environment node
/**
 * The network build (port of build_network.py) reproduces the committed src/data/network.json from its
 * inputs — every station, line, fare, running time and traced track point — and reports the same fixes.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { BuildError, buildNetwork } from "@/domain/metro/build-network"
import { RUNTIME_DIR, loadBuildInputs } from "@/domain/metro/build-inputs"

const committed = JSON.parse(readFileSync(path.join(RUNTIME_DIR, "network.json"), "utf8"))

describe("network build", () => {
  it("rebuilds network.json value for value", { timeout: 120_000 }, async () => {
    const built = buildNetwork(await loadBuildInputs())
    expect(built.stations).toEqual(committed.stations)
    expect(built.lines).toEqual(committed.lines)
    expect(built.fares).toEqual(committed.fares)
    expect(built.data_fixes).toEqual(committed.data_fixes)
    built.segments.forEach((segment, i) =>
      expect(segment, `${segment.line} ${segment.from} -> ${segment.to}`).toEqual(committed.segments[i]),
    )
    expect(built).toEqual(committed)
  })

  it("refuses broken data", { timeout: 120_000 }, async () => {
    const inputs = await loadBuildInputs()
    const missingFare = { ...inputs, fareRows: inputs.fareRows.slice(10) }
    expect(() => buildNetwork(missingFare)).toThrow(BuildError)
    const unknownCorridor = {
      ...inputs,
      locationRows: [...inputs.locationRows, { Station: "Nowhere", Latitude: 23, Longitude: 72, Line: "Moon Corridor" }],
    }
    expect(() => buildNetwork(unknownCorridor)).toThrow(/no line configured/)
  })
})
