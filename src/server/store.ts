/**
 * Shared state that has to outlive a request — the visit total, people online, per-IP limits, the chat
 * answer cache and the models' cooldowns.
 *
 * - With UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN set (or Vercel's KV_REST_API_URL /
 *   KV_REST_API_TOKEN), it lives in Upstash Redis: shared by every server instance and kept across
 *   deploys, so the app also works on serverless hosting.
 * - Without them, it lives in this process (the FastAPI backend's behaviour), and the visit total is
 *   saved to a small JSON file (VISITS_FILE).
 *
 * Redis trouble never breaks a request: reads come back empty, limits let the request through, and
 * the failure is logged.
 */
import { Redis } from "@upstash/redis"

export interface Store {
  readonly kind: "redis" | "memory"
  get<T>(key: string): Promise<T | null>
  getMany<T>(keys: string[]): Promise<(T | null)[]>
  /** ttlSeconds: the value disappears after that long. */
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
  /** Adds one and returns the new value; null if the store is unavailable. */
  incr(key: string): Promise<number | null>
  /**
   * Sliding-window limit (a deque of hit times per key, as backend/app.py kept): records a hit and
   * returns true unless `limit` hits already happened in the last `windowSeconds`.
   */
  hit(key: string, windowSeconds: number, limit: number): Promise<boolean>
  /** Presence: `member` is alive for `ttlSeconds` after each touch. */
  touch(setKey: string, member: string, ttlSeconds: number): Promise<void>
  leave(setKey: string, member: string): Promise<void>
  alive(setKey: string): Promise<number>
}

/**
 * One instance per server process. Next.js may load a module once per route bundle (and again on
 * every hot reload in dev), so in-memory state — the visit counter, rate limits — lives on globalThis.
 */
export function processSingleton<T>(key: string, create: () => T): T {
  const store = globalThis as typeof globalThis & { __metro?: Record<string, unknown> }
  store.__metro ??= {}
  if (!(key in store.__metro)) store.__metro[key] = create()
  return store.__metro[key] as T
}

const PREFIX = `${process.env.REDIS_PREFIX ?? "metro"}:`

// ---------------------------------------------------------------- Upstash Redis

// Atomic sliding window: drop hits older than the window, refuse if full, else record this one.
const HIT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`

const ALIVE_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, tonumber(ARGV[1]))
return redis.call('ZCARD', KEYS[1])`

const uid = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

export class RedisStore implements Store {
  readonly kind = "redis"

  constructor(private readonly redis: Redis) {}

  private async safe<T>(what: string, fallback: T, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (exc) {
      console.log(`[store] redis ${what} failed: ${exc instanceof Error ? exc.message : String(exc)}`)
      return fallback
    }
  }

  get<T>(key: string): Promise<T | null> {
    return this.safe("get", null, () => this.redis.get<T>(PREFIX + key))
  }

  getMany<T>(keys: string[]): Promise<(T | null)[]> {
    if (!keys.length) return Promise.resolve([])
    return this.safe(
      "mget",
      keys.map(() => null),
      () => this.redis.mget<(T | null)[]>(...keys.map((k) => PREFIX + k)),
    )
  }

  set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    return this.safe("set", undefined, async () => {
      if (ttlSeconds) await this.redis.set(PREFIX + key, value, { px: Math.max(1, Math.round(ttlSeconds * 1000)) })
      else await this.redis.set(PREFIX + key, value)
    })
  }

  del(key: string): Promise<void> {
    return this.safe("del", undefined, async () => {
      await this.redis.del(PREFIX + key)
    })
  }

  incr(key: string): Promise<number | null> {
    return this.safe("incr", null, () => this.redis.incr(PREFIX + key))
  }

  hit(key: string, windowSeconds: number, limit: number): Promise<boolean> {
    return this.safe("hit", true, async () => {
      const args = [String(Date.now()), String(windowSeconds * 1000), String(limit), uid()]
      return (await this.redis.eval<string[], number>(HIT_SCRIPT, [PREFIX + key], args)) === 1
    })
  }

  touch(setKey: string, member: string, ttlSeconds: number): Promise<void> {
    return this.safe("touch", undefined, async () => {
      // score = when the member expires
      await this.redis.zadd(PREFIX + setKey, { score: Date.now() + ttlSeconds * 1000, member })
    })
  }

  leave(setKey: string, member: string): Promise<void> {
    return this.safe("leave", undefined, async () => {
      await this.redis.zrem(PREFIX + setKey, member)
    })
  }

  alive(setKey: string): Promise<number> {
    return this.safe("alive", 0, () => this.redis.eval<string[], number>(ALIVE_SCRIPT, [PREFIX + setKey], [String(Date.now())]))
  }
}

// ---------------------------------------------------------------- in this process

export class MemoryStore implements Store {
  readonly kind = "memory"
  private readonly values = new Map<string, { value: unknown; expires: number }>()
  private readonly hits = new Map<string, number[]>()
  private readonly members = new Map<string, Map<string, number>>()

  private live(key: string): { value: unknown; expires: number } | undefined {
    const entry = this.values.get(key)
    if (entry && entry.expires <= Date.now()) {
      this.values.delete(key)
      return undefined
    }
    return entry
  }

  async get<T>(key: string): Promise<T | null> {
    return (this.live(key)?.value as T | undefined) ?? null
  }

  async getMany<T>(keys: string[]): Promise<(T | null)[]> {
    return Promise.all(keys.map((k) => this.get<T>(k)))
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.values.set(key, { value, expires: ttlSeconds ? Date.now() + ttlSeconds * 1000 : Infinity })
    if (this.values.size > 5000) {
      // forget expired entries (the chat cache, cooldowns)
      for (const k of [...this.values.keys()]) this.live(k)
    }
  }

  async del(key: string): Promise<void> {
    this.values.delete(key)
  }

  async incr(key: string): Promise<number> {
    const next = Number((await this.get<number>(key)) ?? 0) + 1
    this.values.set(key, { value: next, expires: this.live(key)?.expires ?? Infinity })
    return next
  }

  async hit(key: string, windowSeconds: number, limit: number): Promise<boolean> {
    const now = performance.now() / 1000
    if (this.hits.size > 10000) {
      // forget idle clients
      for (const [k, times] of this.hits) if (!times.length || now - times[times.length - 1]! > windowSeconds) this.hits.delete(k)
    }
    const times = (this.hits.get(key) ?? []).filter((t) => now - t <= windowSeconds)
    this.hits.set(key, times)
    if (times.length >= limit) return false
    times.push(now)
    return true
  }

  async touch(setKey: string, member: string, ttlSeconds: number): Promise<void> {
    if (!this.members.has(setKey)) this.members.set(setKey, new Map())
    this.members.get(setKey)!.set(member, Date.now() + ttlSeconds * 1000)
  }

  async leave(setKey: string, member: string): Promise<void> {
    this.members.get(setKey)?.delete(member)
  }

  async alive(setKey: string): Promise<number> {
    const set = this.members.get(setKey)
    if (!set) return 0
    for (const [member, expires] of set) if (expires <= Date.now()) set.delete(member)
    return set.size
  }
}

// ---------------------------------------------------------------- which one

function redisFromEnv(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
  return url && token ? new Redis({ url, token, automaticDeserialization: true }) : null
}

/** The process's store. Tests swap it with setStore(new MemoryStore()). */
export function store(): Store {
  return processSingleton<{ current: Store }>("store", () => {
    const redis = redisFromEnv()
    console.log(`[store] ${redis ? "Upstash Redis" : "in-memory (set UPSTASH_REDIS_REST_URL/TOKEN to share state)"}`)
    return { current: redis ? new RedisStore(redis) : new MemoryStore() }
  }).current
}

export function setStore(next: Store): void {
  processSingleton<{ current: Store }>("store", () => ({ current: next })).current = next
}
