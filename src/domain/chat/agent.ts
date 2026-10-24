/**
 * The LLM layer: a LangGraph tool-calling agent (LangChain `createAgent`) on Gemini, streamed, with
 * racing models — the TypeScript port of backend/chatbot/agent.py.
 *
 * - Each Gemini model gets its own agent graph: model node -> tools node -> model node ... until it
 *   answers. The tools are in ./tools (fares, routes, timetables, station gates, knowledge-base search).
 * - Models race: the first one starts at once, and each further model joins if nobody has answered
 *   within HEDGE_SECONDS (or as soon as a model fails). The first to say something wins; the others
 *   are aborted.
 * - A model that just failed is skipped for a while (circuit breaker, kept in the shared store). If
 *   every model is cooling down they are all tried anyway.
 *
 * Gemini errors reach JavaScript as RequestError with the API's message text (no structured status,
 * see tests/fixtures/llm/error-shapes.json), so classify() and cooldownSeconds() read the message.
 */
import { ChatGoogle } from "@langchain/google"
import type { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessageChunk, type BaseMessageLike } from "@langchain/core/messages"
import { createAgent } from "langchain"
import { store } from "@/server/store"
import { TOOLS } from "./tools"

// (model, thinking). Gemini 2.x takes a thinking budget in tokens (0 = off), Gemini 3 a level (minimal, low...).
// Gemini 2.5 Flash-Lite first for its free-tier limits; a Gemini 3 model only steps in if it fails or is slow.
export const DEFAULT_MODELS: [model: string, thinking: string][] = [
  ["gemini-2.5-flash-lite", "0"],
  ["gemini-3.5-flash-lite", "minimal"],
]
/** In seconds. Mutable so tests can shorten them (backend tests monkeypatched the module constants). */
export const timing = {
  HEDGE_SECONDS: 4, // no answer yet: start the next model alongside
  FIRST_CHUNK_SECONDS: 15, // per model: connect + think + tool calls until the first word
  NEXT_CHUNK_SECONDS: 15,
  TOTAL_DEADLINE_SECONDS: 30,
}
const MAX_TOOL_ROUNDS = 3
const COOLDOWN_SECONDS = { rate_limit: 60, soft: 45, hard: 600 }

export type Messages = { role: "user" | "assistant"; content: string }[]
export type LLMErrorKind = "config" | "rate_limit" | "unavailable"
type FailureKind = "config" | "rate_limit" | "hard" | "soft"

export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    detail: string = "",
  ) {
    super(detail || kind)
    this.name = "LLMError"
  }
}

class TimeoutError extends Error {
  override name = "TimeoutError"
}

const monotonic = (): number => performance.now() / 1000

function envFloat(name: string, fallback: number): number {
  const value = Number.parseFloat(process.env[name] ?? "")
  return Number.isFinite(value) ? value : fallback
}

export function configuredModels(): [string, string][] {
  const raw = (process.env.GEMINI_MODELS ?? "").trim()
  if (!raw) return DEFAULT_MODELS
  const models: [string, string][] = []
  for (const item of raw.split(",")) {
    const [name = "", ...rest] = item.trim().split(":")
    const level = rest.join(":")
    if (name) models.push([name, level || "low"])
  }
  return models.length ? models : DEFAULT_MODELS
}

// ---------------------------------------------------------------- the agent

type ChatModelFactory = (apiKey: string, model: string, level: string) => BaseChatModel

function geminiModel(apiKey: string, model: string, level: string): BaseChatModel {
  // maxRetries 0: no retries, other models race instead (Python's max_retries=1 meant the same).
  const common = { model, apiKey, maxOutputTokens: Math.trunc(envFloat("GEMINI_MAX_OUTPUT_TOKENS", 1024)), maxRetries: 0 }
  if (/^\d+$/.test(level)) {
    // Gemini 2.x: a thinking budget, and a low temperature for factual answers
    return new ChatGoogle({ ...common, maxReasoningTokens: Number(level), temperature: envFloat("GEMINI_TEMPERATURE", 0.2) })
  }
  // Gemini 3: a thinking level; its sampling settings are fixed
  return new ChatGoogle({ ...common, thinkingLevel: level as ConstructorParameters<typeof ChatGoogle>[0]["thinkingLevel"] })
}

/** Seam for tests: the chat model behind one agent. */
export const seams: { chatModel: ChatModelFactory } = { chatModel: geminiModel }

type Agent = ReturnType<typeof createAgent>
const agents = new Map<string, Agent>()

/** One compiled graph per model, reused so connections stay open between questions. */
function buildAgent(apiKey: string, model: string, level: string, system: string): Agent {
  const key = JSON.stringify([apiKey, model, level, system])
  let agent = agents.get(key)
  if (!agent) {
    if (agents.size >= 16) agents.delete(agents.keys().next().value!)
    agent = createAgent({ model: seams.chatModel(apiKey, model, level), tools: TOOLS, systemPrompt: system })
    agents.set(key, agent)
  }
  return agent
}

export function clearAgents(): void {
  agents.clear()
}

function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  if (seconds <= 0) return Promise.reject(new TimeoutError())
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), seconds * 1000)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const isAIChunk = (token: unknown): token is AIMessageChunk => AIMessageChunk.isInstance(token as AIMessageChunk)
const textOf = (token: unknown): string => (isAIChunk(token) ? token.text : "")

/**
 * (chunk, metadata) pairs from a LangGraph or chat-model stream, each within its time limit.
 *
 * `.stream()` itself only resolves once the model starts answering, so opening the stream counts
 * against the first chunk's time limit too.
 */
async function* texts(
  opening: Promise<AsyncIterable<unknown>>,
  deadline: number,
): AsyncGenerator<[unknown, Record<string, unknown>]> {
  const firstBy = monotonic() + timing.FIRST_CHUNK_SECONDS
  const stream = await withTimeout(opening, Math.min(firstBy, deadline) - monotonic())
  const iterator = stream[Symbol.asyncIterator]()
  let first = true
  try {
    while (true) {
      const limitBy = first ? firstBy : monotonic() + timing.NEXT_CHUNK_SECONDS
      const item = await withTimeout(iterator.next(), Math.min(limitBy, deadline) - monotonic())
      if (item.done) return
      const [token, meta] = Array.isArray(item.value) ? (item.value as [unknown, Record<string, unknown>]) : [item.value, {}]
      if (textOf(token)) first = false
      yield [token, meta ?? {}]
    }
  } finally {
    void iterator.return?.()
  }
}

/** The answer's text as the model writes it. Tool calls and tool results are handled inside the graph. */
async function* runAgent(
  apiKey: string,
  model: string,
  level: string,
  system: string,
  messages: Messages,
  deadline: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const stream = buildAgent(apiKey, model, level, system).stream(
    { messages },
    { streamMode: "messages", recursionLimit: 2 * MAX_TOOL_ROUNDS + 2, signal },
  ) as Promise<AsyncIterable<unknown>>
  let answered = false
  const toolResults: string[] = []
  for await (const [token, meta] of texts(stream, deadline)) {
    if (meta.langgraph_node === "tools") {
      const { name, content } = token as { name?: string; content?: unknown }
      const text = typeof content === "string" ? content : JSON.stringify(content)
      console.log(`[llm] ${model} tool ${name} -> ${text.includes('"error"') ? "error" : "ok"}`)
      toolResults.push(`${name}: ${text}`)
    } else if (textOf(token)) {
      answered = true
      yield textOf(token)
    }
  }
  if (answered || !toolResults.length) return

  // Gemini 2.5 Flash-Lite often goes silent after a tool result. Ask once more with the results as plain text.
  console.log(`[llm] ${model} said nothing after its tools; asking again with the results`)
  const last = messages[messages.length - 1]!
  const retry: BaseMessageLike[] = [
    { role: "system", content: system },
    ...messages.slice(0, -1),
    {
      ...last,
      content: `${last.content}\n\n[Tool results:\n${toolResults.join("\n")}]\nAnswer the rider now, using these results.`,
    },
  ]
  const plain = seams.chatModel(apiKey, model, level).stream(retry, { signal })
  for await (const [token] of texts(plain, deadline)) {
    if (textOf(token)) yield textOf(token)
  }
}

// ---------------------------------------------------------------- errors and circuit breaker

/** Every message and status along the error's cause chain (LangChain wraps the Gemini error). */
function describeChain(exc: unknown): { text: string; codes: Set<number> } {
  const parts: string[] = []
  const codes = new Set<number>()
  let cause: unknown = exc
  for (let depth = 0; cause && depth < 6; depth++) {
    const err = cause as { message?: unknown; status?: unknown; code?: unknown; response?: { status?: unknown } }
    parts.push(String(err.message ?? cause))
    for (const value of [err.status, err.code, err.response?.status]) {
      if (typeof value === "number") codes.add(value)
      else if (typeof value === "string" && /^\d{3}$/.test(value)) codes.add(Number(value))
      else if (typeof value === "string") parts.push(value)
    }
    cause = (cause as { cause?: unknown }).cause
  }
  return { text: parts.join(" ").toLowerCase(), codes }
}

/** "config" (bad key), "rate_limit", "hard" (model gone or rejects our settings) or "soft" (timeout, overload). */
export function classify(exc: unknown): FailureKind {
  if (exc instanceof LLMError) return exc.kind === "config" || exc.kind === "rate_limit" ? exc.kind : "soft"
  const { text, codes } = describeChain(exc)
  if (codes.has(401) || text.includes("api key") || text.includes("api_key") || text.includes("unauthenticated")) return "config"
  if (codes.has(429) || /resource_exhausted|exceeded your current quota|too many requests/.test(text)) return "rate_limit"
  if (
    [400, 403, 404].some((c) => codes.has(c)) ||
    /is not found for api version|not_found|invalid_argument|permission_denied/.test(text)
  ) {
    return "hard"
  }
  return "soft"
}

/** "Please retry in 19h27m43.78s" / "retryDelay": "64177s" -> seconds. */
function retryDelaySeconds(text: string): number | null {
  const match = /retry(?:delay)?"?\s*(?:in|:)\s*"?((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s))/i.exec(text)
  if (!match) return null
  const [, hours = "0", minutes = "0", seconds = "0"] = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/.exec(match[1]!) ?? []
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

/** How long to skip a model. A used-up daily quota says "retry in 17h": believe it (up to an hour). */
export function cooldownSeconds(exc: unknown, kind: Exclude<FailureKind, "config">): number {
  const delay = retryDelaySeconds(describeChain(exc).text)
  return delay !== null ? Math.min(Math.max(delay, COOLDOWN_SECONDS[kind]), 3600) : COOLDOWN_SECONDS[kind]
}

/** A model that just failed is benched in the shared store, so every server instance skips it. */
const cooldownKey = (model: string): string => `llm:cooldown:${model}`

export async function isCoolingDown(model: string): Promise<boolean> {
  return (await store().get(cooldownKey(model))) !== null
}

async function modelsToTry(): Promise<[string, string][]> {
  const models = configuredModels()
  const benched = await store().getMany(models.map(([model]) => cooldownKey(model)))
  const ready = models.filter((_, i) => benched[i] === null)
  return ready.length ? ready : models
}

// ---------------------------------------------------------------- the race

type RaceEvent = [model: string, piece: string | null, error: unknown]

/** asyncio.Queue's put_nowait/get, with get() bounded by a timeout. */
class EventQueue {
  private items: RaceEvent[] = []
  private waiter: ((event: RaceEvent) => void) | null = null

  put(event: RaceEvent): void {
    if (this.waiter) {
      const resolve = this.waiter
      this.waiter = null
      resolve(event)
    } else this.items.push(event)
  }

  get(seconds: number): Promise<RaceEvent> {
    if (seconds <= 0) return Promise.reject(new TimeoutError())
    if (this.items.length) return Promise.resolve(this.items.shift()!)
    return new Promise<RaceEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null // in the same tick: a later put() queues the event instead of losing it
        reject(new TimeoutError())
      }, seconds * 1000)
      this.waiter = (event) => {
        clearTimeout(timer)
        resolve(event)
      }
    })
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Yields the answer in pieces. Throws LLMError if no model produced anything.
 *
 * An exception after the first piece means the answer was cut off; the caller decides what to say.
 */
export async function* streamReply(apiKey: string, system: string, messages: Messages): AsyncGenerator<string> {
  const deadline = monotonic() + timing.TOTAL_DEADLINE_SECONDS
  const waiting = [...(await modelsToTry())]
  const events = new EventQueue()
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>()
  const started = new Map<string, number>()
  let winner: string | null = null
  let nextStart = 0

  const race = async (model: string, level: string, signal: AbortSignal): Promise<void> => {
    try {
      for await (const piece of runAgent(apiKey, model, level, system, messages, deadline, signal))
        events.put([model, piece, null])
      events.put([model, null, null])
    } catch (exc) {
      if (!signal.aborted) events.put([model, null, exc])
    }
  }

  const startNext = (): void => {
    const [model, level] = waiting.shift()!
    started.set(model, monotonic())
    const controller = new AbortController()
    running.set(model, { controller, done: race(model, level, controller.signal) })
    nextStart = monotonic() + timing.HEDGE_SECONDS
  }

  try {
    startNext()
    while (true) {
      const now = monotonic()
      const hedge = winner === null && waiting.length > 0 && deadline - now > 3
      let event: RaceEvent
      try {
        event = await events.get(hedge ? Math.min(deadline, nextStart) - now : deadline - now)
      } catch (exc) {
        if (!(exc instanceof TimeoutError)) throw exc
        if (hedge && monotonic() < deadline) {
          startNext()
          continue
        }
        throw new LLMError("unavailable", "no model answered in time")
      }
      const [model, piece, exc] = event

      if (winner !== null && winner !== model) continue // an aborted loser's last words
      if (piece !== null) {
        if (winner === null) {
          winner = model
          for (const [other, task] of running) if (other !== model) task.controller.abort()
        }
        yield piece
        continue
      }

      running.get(model)?.controller.abort() // done or failed: release its stream (Python: aclose)
      running.delete(model)
      const took = (monotonic() - started.get(model)!).toFixed(1)
      if (exc === null && winner === model) {
        await store().del(cooldownKey(model))
        console.log(`[llm] ${model} answered in ${took}s`)
        return
      }
      if (winner === model) throw exc // cut off mid-answer
      const error = exc ?? new LLMError("unavailable", `${model} returned an empty reply`)
      const kind = classify(error)
      console.log(`[llm] ${model} failed (${kind}) after ${took}s: ${errorMessage(error).slice(0, 200)}`)
      if (kind === "config") throw new LLMError("config", errorMessage(error))
      await store().set(cooldownKey(model), kind, cooldownSeconds(error, kind))
      if (!running.size) {
        if (!waiting.length || deadline - monotonic() < 3) {
          throw new LLMError(kind === "rate_limit" ? "rate_limit" : "unavailable", errorMessage(error))
        }
        startNext()
      }
    }
  } finally {
    for (const task of running.values()) task.controller.abort()
    await Promise.allSettled([...running.values()].map((task) => task.done))
  }
}
