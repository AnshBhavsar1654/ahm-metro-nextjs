/**
 * Rebuilds src/data/network.json (the only network file the app reads) from the GMRC sheets in data/,
 * the timetable and the OpenStreetMap track — the port of backend/scripts/build_network.py. Run after
 * editing either sheet or refreshing the track:
 *
 *     bun run data:network
 *
 * Refuses to write anything if the data is broken, and prints every correction it had to make.
 */
import { writeFileSync } from "node:fs"
import path from "node:path"
import * as prettier from "prettier"
import { BuildError, buildNetwork, type Network } from "../src/domain/metro/build-network"
import { RUNTIME_DIR, loadBuildInputs } from "../src/domain/metro/build-inputs"

// Coordinates, distances and running times are floats in the Python build ("3.0", not "3"), so the
// file stays byte-for-byte what build_network.py wrote and a rebuild only diffs where data changed.
const FLOAT_KEYS = new Set(["lat", "lon", "km", "minutes"])
const FLOAT = "\u0001float:"

function pythonJson(network: Network): string {
  const float = (x: number) => FLOAT + (Number.isInteger(x) ? x.toFixed(1) : String(x))
  const json = JSON.stringify(
    network,
    (key, value: unknown) => {
      if (typeof value === "number" && FLOAT_KEYS.has(key)) return float(value)
      if (key === "geometry" && Array.isArray(value)) return (value as number[][]).map((p) => p.map(float))
      return value
    },
    1,
  )
  return json.replace(/"\\u0001float:([^"]+)"/g, "$1")
}

async function main(): Promise<void> {
  const network = buildNetwork(await loadBuildInputs())
  const file = path.join(RUNTIME_DIR, "network.json")
  const options = { ...(await prettier.resolveConfig(file)), filepath: file } // the repo's JSON style
  writeFileSync(file, await prettier.format(pythonJson(network), options))
  const fares = Object.values(network.fares).reduce((n, row) => n + Object.keys(row).length, 0)
  console.log(
    `network.json: ${Object.keys(network.stations).length} stations, ${network.lines.length} lines, ` +
      `${network.segments.length} segments, ${fares} fares`,
  )
  for (const fix of network.data_fixes) console.log("  fixed:", fix)
}

main().catch((error) => {
  console.error(error instanceof BuildError ? error.message : error)
  process.exit(1)
})
