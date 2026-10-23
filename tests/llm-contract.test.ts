/**
 * Phase 1 contract tests over the committed LLM spike fixtures (no network, no API key).
 *
 * These encode the exact stream mechanics src/domain/chat/agent.ts will code against in
 * Phase 5, so any library upgrade that changes them surfaces as a test failure.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/llm")
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"))

type AgentEvent = {
  langgraph_node: string
  isAIMessageChunk: boolean
  isToolMessage: boolean
  name?: string
  text?: string
  content?: unknown
  toolCalls?: { name: string; args: Record<string, string> }[]
}

describe("langchain/langgraph stream contract (from live probe fixtures)", () => {
  const fixture = load("agent-stream-b.json") as {
    status: string
    events: AgentEvent[]
  }

  it("streams model and tool-node events under metadata.langgraph_node", () => {
    expect(fixture.status).toBe("ok")
    const first = fixture.events[0]!
    expect(first.langgraph_node).toBe("model_request")
    const nodes = new Set(fixture.events.map((e) => e.langgraph_node))
    expect(nodes.has("model_request")).toBe(true)
    expect(nodes.has("tools")).toBe(true)
  })

  it("yields real AIMessageChunk instances with incremental text", () => {
    const answers = fixture.events.filter((e) => e.isAIMessageChunk && e.langgraph_node === "model_request")
    const deltas = answers.map((e) => e.text ?? "")
    // Deltas recorded by the live probe (gemini-3.5-flash-lite, thinkingLevel minimal).
    expect(deltas.join("")).toBe("The fare from Motera Stadium to Paldi is Rs 15.")
    expect(deltas.some((t) => t.length > 0)).toBe(true)
  })

  it("yields tool results as ToolMessage with the tool name and string content", () => {
    const toolEvent = fixture.events.find((e) => e.isToolMessage && e.langgraph_node === "tools")
    expect(toolEvent, "a ToolMessage event exists").toBeTruthy()
    expect(toolEvent!.name).toBe("get_fare")
    expect(toolEvent!.content).toBe("Rs 15")
  })

  it("carries tool calls on the AIMessageChunk as typed tool_calls with name+args", () => {
    const callEvent = fixture.events.find((e) => (e.toolCalls?.length ?? 0) > 0)
    expect(callEvent, "a tool-call event exists").toBeTruthy()
    expect(callEvent!.toolCalls![0]!.name).toBe("get_fare")
    expect(callEvent!.toolCalls![0]!.args).toEqual({ source: "Motera Stadium", destination: "Paldi" })
  })
})

describe("gemini error classification surfaces (from live probe fixtures)", () => {
  type ErrorShape = { name: string; message: string }
  const shapes = load("error-shapes.json") as {
    bad_key: ErrorShape
    bad_model: ErrorShape
    burst: { sampleError: string | null }
  }
  const dailyCap = load("agent-stream-daily-cap-429.json") as { error: ErrorShape }

  // The JS port classifies from message text (Python parsed error.details); these are the patterns it must match.
  it("bad key is recognisable as a config error", () => {
    expect(shapes.bad_key.message).toMatch(/API key not valid/i)
  })

  it("a missing model is recognisable as a hard error", () => {
    expect(shapes.bad_model.message).toMatch(/is not found for API version/i)
  })

  it("429s carry a parseable retry delay in the message (cooldown source)", () => {
    const message = shapes.burst.sampleError ?? ""
    expect(message).toMatch(/You exceeded your current quota/i)
    expect(message).toMatch(/limit: 10, model: gemini-2\.5-flash-lite/)
    expect(message).toMatch(/Please retry in [\d.]+s/)
  })

  it("an exhausted daily quota reports its own hours-long cooldown", () => {
    const message = dailyCap.error.message
    expect(message).toMatch(/Please retry in 19h27m[\d.]+s/)
  })
})
