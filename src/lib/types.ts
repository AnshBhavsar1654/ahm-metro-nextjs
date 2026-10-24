// Shapes of the API responses the pages render (see src/server/metro-api.ts) and shared prop types.
import type { LucideIcon } from "lucide-react"

export type Icon = LucideIcon

export type Leg = { line: string; from: string; to: string; stops: number; stay_on_train?: boolean }

export type Departure = { time: string; destination: string; approx: boolean }

export type JourneyTrains = {
  board_at: string
  towards: string
  trains: Departure[]
  first: string
  last: string
  source: string
}

export type Alternative = { route: string[]; legs: Leg[]; interchanges: string[]; distance: number; duration_minutes: number }

export type RouteDetails = Alternative & {
  instructions: string[]
  geometry: [number, number][]
  through_service: boolean
  next_trains: JourneyTrains | null
  not_operational: Record<string, string>
  alternatives: Alternative[]
}

export type StationDepartures = {
  station: string
  status?: string
  directions: { towards: string; trains: Departure[]; first: string; last: string }[]
  source: string | null
}

export type LineTrack = { id: string; name: string; status: string; stations: string[]; geometry: [number, number][] }
