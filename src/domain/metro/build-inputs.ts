/**
 * Reads the network build's inputs from disk (Node only): the two GMRC workbooks and the OpenStreetMap
 * track in data/, the timetable in src/data/. Shared by scripts/build-network.ts and its test.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import ExcelJS from "exceljs"
import type { BuildInputs } from "./build-network"
import { readSheet } from "./excel-parse"

export const SOURCES_DIR = path.join(process.cwd(), "data")
export const RUNTIME_DIR = path.join(process.cwd(), "src", "data")

async function firstSheet(file: string): Promise<Record<string, unknown>[]> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.readFile(file)
  const sheet = book.getWorksheet(1)
  if (!sheet) throw new Error(`${path.basename(file)}: no first worksheet`)
  return readSheet(sheet)
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8"))

export async function loadBuildInputs(sources = SOURCES_DIR, runtime = RUNTIME_DIR): Promise<BuildInputs> {
  return {
    locationRows: await firstSheet(path.join(sources, "Location.xlsx")),
    fareRows: await firstSheet(path.join(sources, "Fare Matrix.xlsx")),
    timetable: json(path.join(runtime, "timetable.json")),
    tracks: json(path.join(sources, "tracks.json")),
  }
}
