/**
 * Self-ping so Render's free tier doesn't spin the service down while the metro is open — the port of
 * backend/metro/keepalive.py, started once per server process from src/instrumentation.ts.
 *
 * The ping goes to the service's public URL (Render sets RENDER_EXTERNAL_URL), so it passes through
 * Render's proxy and counts as real inbound traffic. Locally the variable is unset and nothing runs.
 *
 * Pings only run between KEEPALIVE_START_HOUR and KEEPALIVE_END_HOUR, Ahmedabad time (Render's servers
 * run on UTC), so the service is free to sleep overnight instead of using up the workspace's 750 free
 * instance hours. Note that a sleeping process cannot wake itself: an outside caller (a scheduled ping)
 * has to make the first request of the day.
 */
import { istNow, type StationTime } from "@/domain/metro/timetable"

const DEFAULT_INTERVAL_SECONDS = 600 // 10 minutes; Render sleeps free services after 15
const DEFAULT_START_HOUR = 6
const DEFAULT_END_HOUR = 23
const TICK_SECONDS = 60

export function targetUrl(): string | null {
  const base = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL
  return base ? `${base.replace(/\/+$/, "")}/health` : null
}

function intervalSeconds(): number {
  const value = Number.parseInt(process.env.KEEPALIVE_INTERVAL_SECONDS ?? "", 10)
  return Number.isNaN(value) ? DEFAULT_INTERVAL_SECONDS : Math.max(60, value)
}

function hour(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || !/^\s*[+-]?\d+\s*$/.test(raw)) return fallback
  const value = Number.parseInt(raw, 10)
  return value >= 0 && value <= 24 ? value : fallback
}

/** True inside the daily window, in Ahmedabad time (Render's servers run on UTC). */
export function active(now: StationTime): boolean {
  return hour("KEEPALIVE_START_HOUR", DEFAULT_START_HOUR) <= now.hour && now.hour < hour("KEEPALIVE_END_HOUR", DEFAULT_END_HOUR)
}

/** Start the ping loop. Returns a stop() callable (a no-op if disabled). */
export function startKeepalive(): () => void {
  const url = targetUrl()
  if (!url) return () => {}

  const interval = intervalSeconds()
  let lastPing = 0
  const timer = setInterval(async () => {
    if (!active(istNow())) {
      lastPing = 0 // the first ping after the window opens is immediate
      return
    }
    if (performance.now() / 1000 - lastPing < interval) return
    lastPing = performance.now() / 1000
    try {
      await fetch(url, { signal: AbortSignal.timeout(15_000) })
    } catch (exc) {
      console.log(`[keepalive] ping failed: ${exc instanceof Error ? exc.message : String(exc)}`)
    }
  }, TICK_SECONDS * 1000)
  timer.unref?.()
  const pad = (n: number) => String(n).padStart(2, "0")
  console.log(
    `[keepalive] pinging ${url} every ${interval}s between ${pad(hour("KEEPALIVE_START_HOUR", DEFAULT_START_HOUR))}:00 ` +
      `and ${pad(hour("KEEPALIVE_END_HOUR", DEFAULT_END_HOUR))}:00 IST`,
  )
  return () => clearInterval(timer)
}
