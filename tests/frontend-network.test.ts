// @vitest-environment node
/** src/lib/network.ts keeps its own copy of line order and station status for the diagram; it must match the network data. */
import { expect, test } from "vitest"
import { NETWORK, stationStatus as serverStatus } from "@/domain/metro/network"
import { LINE_STATIONS, STATION_STATUS } from "@/lib/network"

test("the diagram's lines and statuses match the network", () => {
  expect(LINE_STATIONS).toEqual(Object.fromEntries(NETWORK.lines.map((line) => [line.id, line.stations])))
  const named = (value: string) => Object.keys(STATION_STATUS).filter((s) => STATION_STATUS[s] === value)
  const underConstruction = [...NETWORK.coords.keys()].filter((s) => serverStatus(s) === "under construction")
  expect(named("construction").sort()).toEqual(underConstruction.sort())
  const wip = [...NETWORK.coords.keys()].filter((s) => serverStatus(s) === "work in progress")
  expect(named("wip").sort()).toEqual(wip.sort())
})
