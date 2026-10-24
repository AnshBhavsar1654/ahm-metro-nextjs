/**
 * Phase 1 LLM spike. Answers, with a real key and real models, the three questions the
 * agent port depends on:
 *
 *   A. What does a plain ChatGoogle.stream() yield for the DEFAULT_MODELS pair (chunk shapes,
 *      timings, thinking_budget/thinking_level accepted)?
 *   B. What does a LangGraph createAgent yield under streamMode "messages" — chunk types,
 *      metadata.langgraph_node, tool-call events?
 *   C. What do Gemini/LangChain error objects look like for a bad key (config), a bad model
 *      (hard) and a rate-limited burst (429 + retryDelay)?
 *
 * Artifacts land in tests/fixtures/llm/ (committed, key-free). Run: bun run scripts/llm-spike.ts
 * NOTE: probe C burns ~12 flash-lite RPM for a minute. Daily quota is untouched.
 */
import fs from "node:fs"
import path from "node:path"

const FIXTURES = path.join(import.meta.dirname, "..", "tests", "fixtures", "llm")
fs.mkdirSync(FIXTURES, { recursive: true })

const MODEL_A = "gemini-2.5-flash-lite"
const MODEL_B = "gemini-3.5-flash-lite"

const apiKey = process.env.GEMINI_API_KEY ?? ""
if (!apiKey) {
  console.error("llm-spike: GEMINI_API_KEY missing (.env)")
  process.exit(1)
}

const save = (name: string, data: unknown): string => {
  const file = path.join(FIXTURES, name)
  fs.writeFileSync(file, JSON.stringify(data, null, 1))
  return file
}

const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10

type ErrorShape = {
  name: string
  message: string
  code?: unknown
  status?: unknown
  details?: unknown
  cause?: string
}

/** Flatten LangChain/Gemini error wrappers the way chatbot/agent.py's classify()/cooldown_seconds() do. */
function shape(error: unknown): ErrorShape {
  const err = error as {
    name?: string
    message?: string
    code?: unknown
    status?: unknown
    details?: unknown
    cause?: unknown
  }
  const out: ErrorShape = {
    name: err?.name ?? typeof error,
    message: String(err?.message ?? error).slice(0, 500),
    code: err?.code,
    status: err?.status,
    details: err?.details,
  }
  if (out.details === undefined) delete out.details
  if (err?.cause) {
    const cause = err.cause as { status?: unknown; code?: unknown; message?: string; details?: unknown }
    out.cause = JSON.stringify({
      name: (cause as { name?: string }).name,
      message: String(cause?.message ?? "").slice(0, 300),
      code: cause?.code,
      status: cause?.status,
      details: cause?.details,
    })
  }
  return out
}

/** Probe A: raw model streaming for both default models. */
async function probeRawModel(): Promise<Record<string, unknown>> {
  const { ChatGoogle } = await import("@langchain/google")
  // @langchain/google has no constructor `timeout` (Python's ChatGoogleGenerativeAI does) — the
  // port wraps per-call deadlines in the race layer instead of passing them to the model.
  const generate = (model: string, thinking: string) =>
    thinking === "minimal"
      ? new ChatGoogle({ model, apiKey, reasoningEffort: "minimal", maxOutputTokens: 1024, maxRetries: 1 })
      : new ChatGoogle({
          model,
          apiKey,
          maxReasoningTokens: Number(thinking),
          temperature: 0.2,
          maxOutputTokens: 1024,
          maxRetries: 1,
        })

  const out: Record<string, unknown> = {}
  for (const [model, thinking] of [
    [MODEL_A, "0"],
    [MODEL_B, "minimal"],
  ] as const) {
    const model_ = generate(model, thinking)
    let first: number | undefined
    let last = 0
    const chunks: string[] = []
    let usage: unknown = null
    const started = performance.now()
    try {
      const stream = await model_.stream("Reply with exactly: OK " + model)
      for await (const chunk of stream) {
        if (first === undefined && chunk.text) {
          first = ms(started)
        }
        if (chunk.text) {
          // first token latency / total time, sampled per chunk
          last = ms(started)
          chunks.push(String(chunk.text))
        }
        if ((chunk as { usage_metadata?: unknown }).usage_metadata) {
          usage = (chunk as { usage_metadata?: unknown }).usage_metadata
        }
      }
      out[`plain/${model}`] = {
        status: "ok",
        firstTokenMs: first,
        totalTimeMs: last,
        chunkCount: chunks.length,
        text: chunks.join(""),
        usageMetadata: usage,
      }
    } catch (error) {
      out[`plain/${model}`] = { status: "error", error: shape(error) }
    }
  }
  return out
}

/** Probe B: LangGraph agent tool-calling under streamMode "messages" (single mode: live [chunk, meta] tuples). */
async function probeAgent(target: "a" | "b"): Promise<Record<string, unknown>> {
  const { createAgent } = await import("langchain")
  const { tool } = await import("@langchain/core/tools")
  const { AIMessageChunk, ToolMessage } = await import("@langchain/core/messages")
  const { z } = await import("zod")
  const { ChatGoogle } = await import("@langchain/google")

  const [model, thinking] = target === "b" ? ([MODEL_B, "minimal"] as const) : ([MODEL_A, "0"] as const)

  const get_fare = tool(
    async ({ source, destination }) => {
      const net = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "src", "data", "network.json"), "utf8"))
      const fare = (net.fares as Record<string, Record<string, number>>)[source]?.[destination]
      return fare == null ? `no fare for ${source} -> ${destination}` : `Rs ${fare}`
    },
    {
      name: "get_fare",
      description: "Fare in rupees between two Ahmedabad Metro stations.",
      schema: z.object({ source: z.string(), destination: z.string() }),
    },
  )

  const agent = createAgent({
    model:
      thinking === "minimal"
        ? new ChatGoogle({ model, apiKey, reasoningEffort: "minimal", maxOutputTokens: 1024, maxRetries: 1 })
        : new ChatGoogle({
            model,
            apiKey,
            maxReasoningTokens: Number(thinking),
            temperature: 0.2,
            maxOutputTokens: 1024,
            maxRetries: 1,
          }),
    tools: [get_fare],
    systemPrompt: "You are the Ahmedabad Metro assistant. Always answer with the get_fare tool; never from memory.",
  })

  const started = performance.now()
  const events: unknown[] = []
  let firstNode: string | null = null
  try {
    // Single-string streamMode yields live [chunk, meta] tuples (the array form tags items
    // as [modeTag, [serializedChunk, meta]] — that nesting is what earlier probes recorded).
    const stream = await agent.stream(
      {
        messages: [["user" as const, "What is the fare from Motera Stadium to Paldi?"]],
      },
      { streamMode: "messages", recursionLimit: 8 },
    )
    for await (const [chunk, meta] of stream as AsyncIterable<[unknown, Record<string, unknown>]>) {
      firstNode ??= (meta?.langgraph_node as string) ?? "<none>"
      events.push({
        atMs: ms(started),
        langgraph_node: (meta?.langgraph_node as string) ?? "<none>",
        isAIMessageChunk: chunk instanceof AIMessageChunk,
        isToolMessage: chunk instanceof ToolMessage,
        name: (chunk as { name?: string }).name,
        text: (chunk as { text?: string }).text,
        content: (chunk as { content?: unknown }).content,
        toolCalls: (chunk as { tool_calls?: unknown[] }).tool_calls,
      })
    }
  } catch (error) {
    return { status: "error", error: shape(error), events }
  }
  return { status: "ok", firstNode, eventCount: events.length, events }
}

/** Probe C: error surfaces (bad key / bad model) and a rate-limit burst for the 429 shape. */
async function probeErrors(): Promise<Record<string, unknown>> {
  const { ChatGoogle } = await import("@langchain/google")
  const out: Record<string, unknown> = {}

  const badKey = new ChatGoogle({ model: MODEL_A, apiKey: "not-a-real-key", maxRetries: 1 })
  try {
    await badKey.invoke("hi")
    out["bad_key"] = "unexpected success"
  } catch (e) {
    out["bad_key"] = shape(e)
  }

  const badModel = new ChatGoogle({ model: "gemini-does-not-exist-42", apiKey, maxRetries: 1 })
  try {
    await badModel.invoke("hi")
    out["bad_model"] = "unexpected success"
  } catch (e) {
    out["bad_model"] = shape(e)
  }

  // 12 rapid calls against a ~10 RPM free tier: expect RESOURCE_EXHAUSTED (429) with retryDelay.
  const burst = new ChatGoogle({ model: MODEL_A, apiKey, maxRetries: 0, maxOutputTokens: 16 })
  let rateLimited: string | null = null
  const codes = new Map<string, number>()
  const started = performance.now()
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => burst.invoke("hi")))
  for (const result of results) {
    if (result.status === "fulfilled") {
      codes.set("ok", (codes.get("ok") ?? 0) + 1)
      continue
    }
    const info = shape(result.reason)
    const digest = `${info.name}|${info.message.slice(0, 80)}`
    codes.set(digest, (codes.get(digest) ?? 0) + 1)
    if (!rateLimited) rateLimited = JSON.stringify(info, null, 1)
  }
  out["burst"] = { elapsedMs: ms(started), outcomes: Object.fromEntries(codes), sampleError: rateLimited }
  return out
}

async function main(): Promise<void> {
  const only = process.argv[2] ?? "all" // "raw" | "agent" | "errors" | "all"

  if (only === "all" || only === "raw") {
    console.log("tracing raw ChatGoogle stream for both models...")
    const raw = await probeRawModel()
    save("raw-model-stream.json", raw)
    for (const [key, value] of Object.entries(raw)) {
      console.log(`  ${key}: ${JSON.stringify(value).slice(0, 160)}...`)
    }
  }

  if (only === "all" || only.startsWith("agent")) {
    const [, target = "b"] = only.split(":")
    console.log(`tracing agent stream (streamMode messages, 1 tool, model ${target})...`)
    const agent = await probeAgent(target === "a" ? "a" : "b")
    save(target === "a" ? "agent-stream-a.json" : "agent-stream-b.json", agent)
    console.log(`  ${agent.status}: ${agent.eventCount} events, first from node ${agent.firstNode ?? "?"}`)
    if (agent.events) {
      const byNode: Record<string, number> = {}
      for (const e of agent.events as { langgraph_node: string }[]) {
        byNode[e.langgraph_node] = (byNode[e.langgraph_node] ?? 0) + 1
      }
      console.log("  events by node:", JSON.stringify(byNode))
    }
  }

  if (only === "all" || only === "errors") {
    console.log("tracing error surfaces (bad key, bad model, 429 burst)...")
    const errors = await probeErrors()
    save("error-shapes.json", errors)
    console.log(JSON.stringify(errors, null, 1).slice(0, 1200))
  }
}

main().catch((error) => {
  console.error("llm-spike failed:", error)
  process.exit(1)
})
