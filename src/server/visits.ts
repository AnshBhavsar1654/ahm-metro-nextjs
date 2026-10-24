/**
 * Site visit counter with live updates for the footer — the port of backend/metro/visits.py, on top of
 * the shared store (./store).
 *
 * - With Upstash Redis, the total, the per-IP limit and who is online are shared by every server
 *   instance and survive deploys. Without it, they live in this process and the total is saved to a
 *   small JSON file after each visit (VISITS_FILE), as the FastAPI backend did.
 * - The browser decides what a visit is (once per browser per day) and reports it with POST /api/visits.
 *   The server also ignores more than a few visits per IP per hour, so a script can't inflate the number.
 * - Every open footer holds a server-sent-events stream; it gets the new numbers whenever the total or
 *   the number of people online changes. "Online" is the number of open streams (a presence set: each
 *   stream refreshes its entry while open, so one that dies without saying goodbye drops out).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { processSingleton, store as currentStore, type Store } from "./store"

export const MAX_VISITS_PER_IP_PER_HOUR = 5
export const HEARTBEAT_SECONDS = 25 // keeps proxies from closing an idle stream
const POLL_SECONDS = 5 // with Redis: how often a stream looks for changes made by other instances
const PRESENCE_SECONDS = 60 // an open stream refreshes its presence well within this
const TOTAL_KEY = "visits:total"
const ONLINE_KEY = "visits:online"

export type VisitSnapshot = { total: number; online: number }

const visitsFile = (): string => process.env.VISITS_FILE || path.join(process.cwd(), ".data", "visits.json")

function load(file: string): number {
  try {
    const total = Number((JSON.parse(readFileSync(file, "utf8")) as { total?: unknown }).total ?? 0)
    return Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0
  } catch {
    return 0
  }
}

export class VisitCounter {
  private localTotal: number // the in-process total (no Redis)
  private lastTotal = 0 // the last total Redis gave us, in case it is briefly unreachable
  private version = 0 // bumped on every local change, so a stream never misses one made while it was busy
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly store: Store = currentStore(),
    private readonly file: string = visitsFile(),
  ) {
    this.localTotal = store.kind === "memory" ? load(file) : 0
  }

  private async total(): Promise<number> {
    if (this.store.kind === "memory") return this.localTotal
    const total = await this.store.get<number>(TOTAL_KEY)
    if (total !== null) this.lastTotal = Number(total)
    return this.lastTotal
  }

  async snapshot(): Promise<VisitSnapshot> {
    const [total, online] = await Promise.all([this.total(), this.store.alive(ONLINE_KEY)])
    return { total, online }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ total: this.localTotal }), "utf8")
      renameSync(tmp, this.file)
    } catch (exc) {
      // read-only disk: keep counting in memory
      console.log(`[visits] could not save: ${exc instanceof Error ? exc.message : String(exc)}`)
    }
  }

  private notify(): void {
    this.version++
    for (const listener of [...this.listeners]) listener()
  }

  async record(ip: string): Promise<VisitSnapshot> {
    if (await this.store.hit(`visits:ip:${ip}`, 3600, MAX_VISITS_PER_IP_PER_HOUR)) {
      if (this.store.kind === "memory") {
        this.localTotal++
        this.save()
      } else {
        const total = await this.store.incr(TOTAL_KEY)
        if (total !== null) this.lastTotal = total
      }
      this.notify()
    }
    return this.snapshot()
  }

  /**
   * Current numbers now, then again after every change; null is a heartbeat. Counts as one person
   * online while open. Aborting `signal` ends it at once (the visitor left).
   */
  async *stream(signal?: AbortSignal): AsyncGenerator<VisitSnapshot | null> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    let wake: (() => void) | null = null
    const listener = () => wake?.()
    this.listeners.add(listener)
    signal?.addEventListener("abort", listener)
    const poll = this.store.kind === "redis" ? POLL_SECONDS : Infinity
    try {
      await this.store.touch(ONLINE_KEY, id, PRESENCE_SECONDS)
      this.notify()
      let seen = this.version
      let last = await this.snapshot()
      let quietSince = performance.now() / 1000
      yield last
      while (!signal?.aborted) {
        const untilHeartbeat = quietSince + HEARTBEAT_SECONDS - performance.now() / 1000
        if (this.version === seen)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.max(0, Math.min(poll, untilHeartbeat)) * 1000)
            wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
        wake = null
        if (signal?.aborted) return
        seen = this.version
        await this.store.touch(ONLINE_KEY, id, PRESENCE_SECONDS)
        const now = await this.snapshot()
        if (now.total !== last.total || now.online !== last.online) {
          last = now
          quietSince = performance.now() / 1000
          yield now
        } else if (performance.now() / 1000 - quietSince >= HEARTBEAT_SECONDS) {
          quietSince = performance.now() / 1000
          yield null // heartbeat
        }
      }
    } finally {
      signal?.removeEventListener("abort", listener)
      this.listeners.delete(listener)
      await this.store.leave(ONLINE_KEY, id)
      this.notify()
    }
  }
}

export const counter = (): VisitCounter => processSingleton("visits", () => new VisitCounter())
