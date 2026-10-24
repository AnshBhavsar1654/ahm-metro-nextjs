// @vitest-environment node
/**
 * The agent layer and the assistant's failure handling — the port of backend/tests/test_chatbot.py.
 * No network: the real LangGraph agent runs on a scripted chat model in place of Gemini.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager"
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs"
import * as agent from "@/domain/chat/agent"
import { MemoryStore, setStore } from "@/server/store"
import * as chat from "@/domain/chat/assistant"
import { INTERRUPTED } from "@/domain/chat/rules"
import { TOOLS, gateData, getLineStations, getStationInfo, searchKnowledgeBase, getJourney } from "@/domain/chat/tools"

const MODELS = ["model-a", "model-b", "model-c"] // the race order in these tests (GEMINI_MODELS)

const textChunk = (text: string) => new AIMessageChunk({ content: text })
const callChunk = (name: string, args: Record<string, string>) =>
  new AIMessageChunk({
    content: "",
    tool_call_chunks: [{ name, args: JSON.stringify(args), id: "c1", index: 0, type: "tool_call_chunk" }],
  })

/** Gemini's errors as @langchain/google raises them: a RequestError carrying the API's message. */
function apiError(kind: "rate_limit" | "unavailable" | "not_found" | "bad_key" | "internal" | "unauthenticated"): Error {
  const messages = {
    rate_limit: "You exceeded your current quota, please check your plan and billing details.",
    unavailable: "The model is overloaded. Please try again later.",
    not_found: "models/model-x is not found for API version v1beta, or is not supported for generateContent.",
    bad_key: "API key not valid. Please pass a valid API key.",
    internal:
      "An internal error has occurred. Please retry or report in https://developers.generativeai.google/guide/troubleshooting",
    unauthenticated: "Request had invalid authentication credentials. Expected OAuth 2 access token (UNAUTHENTICATED)",
  }
  const error = new Error(messages[kind])
  error.name = "RequestError"
  return error
}

const HANG = Symbol("hang") // a model that never produces anything
type Round = Error | typeof HANG | (AIMessageChunk | Error)[]

/** `plan[model]` is a list of rounds (one per model call); the last round repeats. */
class Script {
  readonly calls: [string, BaseMessage[]][] = []
  constructor(readonly plan: Record<string, Round[]>) {}

  nextRound(model: string, messages: BaseMessage[]): Round {
    this.calls.push([model, [...messages]])
    const rounds = this.plan[model] ?? [apiError("unavailable")]
    return rounds.length > 1 ? rounds.shift()! : rounds[0]!
  }

  get models(): string[] {
    return this.calls.map(([model]) => model)
  }
}

/** Stands in for Gemini inside the real LangGraph agent. Each model call takes the next round of its script. */
class FakeChat extends BaseChatModel {
  constructor(
    readonly modelName: string,
    readonly script: Script,
  ) {
    super({})
  }

  _llmType(): string {
    return "fake"
  }

  override bindTools(): this {
    return this
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const step = this.script.nextRound(this.modelName, messages)
    if (step instanceof Error) throw step
    if (step === HANG) {
      await new Promise((_, reject) => {
        const timer = setTimeout(reject, 3_600_000)
        options.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))))
      })
      return
    }
    for (const item of step) {
      if (item instanceof Error) throw item
      const chunk = new ChatGenerationChunk({ message: item, text: item.text })
      yield chunk
      // As @langchain/google does: LangGraph's "messages" stream is fed by these callbacks.
      await runManager?.handleLLMNewToken(item.text, undefined, undefined, undefined, undefined, { chunk })
    }
  }

  async _generate(messages: BaseMessage[], options: this["ParsedCallOptions"]): Promise<ChatResult> {
    let message: AIMessageChunk | null = null
    for await (const chunk of this._streamResponseChunks(messages, options)) {
      message = message ? message.concat(chunk.message as AIMessageChunk) : (chunk.message as AIMessageChunk)
    }
    const final = message ?? new AIMessageChunk({ content: "" })
    const ai = new AIMessage({ content: final.content, tool_calls: final.tool_calls ?? [] })
    return { generations: [{ message: ai, text: ai.text }] }
  }
}

const timingDefaults = { ...agent.timing }
const realChatModel = agent.seams.chatModel
const realRules = chat.layers.answerWithRules

function install(plan: Record<string, Round[]>): Script {
  const script = new Script(plan)
  agent.seams.chatModel = (_key, model) => new FakeChat(model, script)
  return script
}

beforeEach(() => {
  setStore(new MemoryStore())
  agent.clearAgents()
  process.env.GEMINI_MODELS = "model-a:0,model-b:minimal,model-c:minimal"
})

afterEach(() => {
  Object.assign(agent.timing, timingDefaults)
  agent.seams.chatModel = realChatModel
  chat.layers.answerWithRules = realRules
  agent.clearAgents()
  delete process.env.GEMINI_MODELS
})

async function askLlm(message = "what is the refund policy", history: unknown[] = []): Promise<string> {
  let text = ""
  for await (const piece of agent.streamReply("key", "system", chat.buildMessages(message, history))) text += piece
  return text
}

async function answer(message: string, history: unknown[] = [], key = "key") {
  const texts: string[] = []
  let source: string | null = null
  for await (const event of chat.answerStream(message, key, history)) {
    if (event.type === "delta") texts.push(event.text)
    else source = event.source
  }
  return { response: texts.join("").trim(), source }
}

// ---------------------------------------------------------------- model race

describe("model race", () => {
  it("streams pieces in order", async () => {
    install({ [MODELS[0]!]: [[textChunk("Unused tickets "), textChunk("are refundable.")]] })
    expect(await askLlm()).toBe("Unused tickets are refundable.")
  })

  it("falls through to the next model", async () => {
    const s = install({
      "model-a": [apiError("rate_limit")],
      "model-b": [apiError("unavailable")],
      "model-c": [[textChunk("ok from third")]],
    })
    expect(await askLlm()).toBe("ok from third")
    expect(s.models).toEqual(MODELS)
  })

  it("abandons a silent model", async () => {
    Object.assign(agent.timing, { FIRST_CHUNK_SECONDS: 0.05, HEDGE_SECONDS: 10 })
    const s = install({ "model-a": [HANG], "model-b": [[textChunk("fast answer")]] })
    expect(await askLlm()).toBe("fast answer")
    expect(s.models.slice(0, 2)).toEqual(MODELS.slice(0, 2))
  })

  it("gives a slow model a racer, and the first answer wins", async () => {
    Object.assign(agent.timing, { HEDGE_SECONDS: 0.05 })
    const s = install({ "model-a": [HANG], "model-b": [[textChunk("racer "), textChunk("answer")]] })
    expect(await askLlm()).toBe("racer answer")
    expect(s.models).toEqual(MODELS.slice(0, 2))
    expect(await agent.isCoolingDown("model-a")).toBe(false) // merely slower, not broken
  })

  it("tries the next model after an empty reply", async () => {
    install({ "model-a": [[]], "model-b": [[textChunk("second")]] })
    expect(await askLlm()).toBe("second")
  })

  it("skips failed models on the next question", async () => {
    const s = install({
      "model-a": [apiError("rate_limit")],
      "model-b": [apiError("not_found")],
      "model-c": [[textChunk("answer")]],
    })
    await askLlm()
    s.calls.length = 0
    expect(await askLlm()).toBe("answer")
    expect(s.models).toEqual(["model-c"]) // no time wasted on the two that just failed
  })

  it("tries every model when all are cooling down", async () => {
    const s = install(Object.fromEntries(MODELS.map((m) => [m, [apiError("unavailable")]])))
    await expect(askLlm()).rejects.toBeInstanceOf(agent.LLMError)
    s.plan["model-a"] = [[textChunk("recovered")]]
    expect(await askLlm()).toBe("recovered")
  })

  it("stops at once on an invalid key", async () => {
    const s = install(Object.fromEntries(MODELS.map((m) => [m, [apiError("bad_key")]])))
    const error = await askLlm().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(agent.LLMError)
    expect((error as agent.LLMError).kind).toBe("config")
    expect(s.calls).toHaveLength(1)
  })
})

describe("error classification and configuration", () => {
  it("classifies wrapped Gemini errors", () => {
    const wrapped = new Error("Error calling model", { cause: apiError("rate_limit") })
    expect(agent.classify(wrapped)).toBe("rate_limit")
    expect(agent.classify(apiError("bad_key"))).toBe("config")
    expect(agent.classify(apiError("not_found"))).toBe("hard")
    expect(agent.classify(apiError("unavailable"))).toBe("soft")
    expect(agent.classify(Object.assign(new Error("Unauthorized"), { status: 401 }))).toBe("config")
  })

  it("benches a model with a used-up daily quota for longer", () => {
    const daily = new Error(
      "You exceeded your current quota ... limit: 20, model: gemini-2.5-flash-lite\nPlease retry in 19h27m43.784996367s.",
    )
    expect(agent.cooldownSeconds(daily, "rate_limit")).toBe(3600)
    expect(agent.cooldownSeconds(new Error('{"retryDelay": "64177s"}'), "rate_limit")).toBe(3600)
    expect(agent.cooldownSeconds(new Error("Please retry in 9.405504558s."), "rate_limit")).toBe(60)
    expect(agent.cooldownSeconds(new Error("Please retry in 2m5s."), "rate_limit")).toBe(125)
    expect(agent.cooldownSeconds(apiError("rate_limit"), "rate_limit")).toBe(60)
  })

  it("reads the models from GEMINI_MODELS", () => {
    process.env.GEMINI_MODELS = "gemini-x:minimal, gemini-y"
    expect(agent.configuredModels()).toEqual([
      ["gemini-x", "minimal"],
      ["gemini-y", "low"],
    ])
    delete process.env.GEMINI_MODELS
    expect(agent.configuredModels()[0]).toEqual(["gemini-2.5-flash-lite", "0"])
  })

  it("sends a thinking budget to Gemini 2 and a thinking level to Gemini 3", () => {
    type Params = { generationConfig: { temperature?: number; thinkingConfig: Record<string, unknown> } }
    const params = (model: string, level: string) =>
      (realChatModel("key", model, level) as unknown as { invocationParams(o: object): Params }).invocationParams({})
        .generationConfig
    const flash2 = params("gemini-2.5-flash-lite", "0")
    expect(flash2.thinkingConfig.thinkingBudget).toBe(0)
    expect(flash2.temperature).toBe(0.2)
    const flash3 = params("gemini-3.5-flash-lite", "minimal")
    expect(flash3.thinkingConfig.thinkingLevel).toBe("MINIMAL")
    expect(flash3.temperature).toBeUndefined()
  })
})

// ---------------------------------------------------------------- tools and retrieval

/** Run a tool as the agent would; bad names and arguments come back as errors, as the model sees them. */
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const found = TOOLS.find((t) => t.name === name)
  if (!found) return { error: `Unknown tool '${name}'.` }
  try {
    return JSON.parse(String(await found.invoke(args))) as Record<string, unknown>
  } catch (exc) {
    return { error: `Bad arguments for ${name}: ${String(exc)}` }
  }
}

describe("tools and retrieval", () => {
  it("lets the agent call a tool and answer from its result", async () => {
    const s = install({
      "model-a": [
        [callChunk("get_journey", { from_station: "ઇન્ફોસિટી", to_station: "mahatma mandir" })],
        [textChunk("The fare is Rs 15.")],
      ],
    })
    expect(await askLlm("how much to go from my office to the temple")).toBe("The fare is Rs 15.")
    const toolMessage = s.calls[1]![1].at(-1)!
    expect(ToolMessage.isInstance(toolMessage)).toBe(true)
    expect((toolMessage as ToolMessage).tool_call_id).toBe("c1")
    const result = JSON.parse(String(toolMessage.content)) as Record<string, unknown>
    expect(result.fare_rupees).toBe(15)
    expect(result.from).toBe("Infocity")
  })

  it("answers from the tool results when the model goes silent after a tool", async () => {
    const s = install({
      "model-a": [[callChunk("get_station_info", { station: "kalupur" })], [textChunk("")], [textChunk("Lift near Gate No. 1.")]],
    })
    expect(await askLlm("which gate has the lift at kalupur?")).toBe("Lift near Gate No. 1.")
    const retryTurn = String(s.calls[2]![1].at(-1)!.content)
    expect(retryTurn).toContain("Tool results:")
    expect(retryTurn).toContain("Kalupur Railway Station")
    expect(s.models).toEqual(["model-a", "model-a", "model-a"])
    expect(await agent.isCoolingDown("model-a")).toBe(false)
  })

  it("sends station and timetable facts with the question", () => {
    let turn = chat.buildMessages("which gate has the lift at kalupur railway station?", []).at(-1)!.content
    expect(turn).toContain("Station facts")
    expect(turn).toContain("Lift No. 01 near Gate No. 01")
    expect(turn).not.toContain("Timetable")
    turn = chat.buildMessages("when is the next train from infocity?", []).at(-1)!.content
    expect(turn).toContain("Timetable")
    expect(turn).toContain("Infocity")
  })

  it("resolves lines and reports unknown stations", async () => {
    expect((await callTool("get_line_stations", { line: "purple" })).stations_in_order).toEqual(["GNLU", "PDEU", "Gift City"])
    const info = await callTool("get_station_info", { station: "old high court" })
    expect(info.is_interchange).toBe(true)
    expect(info.entry_exit_gates).toBeTruthy()
    expect(info.lifts).toBeTruthy()
    expect(await callTool("get_journey", { from_station: "Mars", to_station: "Paldi" })).toHaveProperty("error")
    expect(await callTool("get_journey", { from_station: "Paldi" })).toHaveProperty("error") // missing argument
    expect(await callTool("drop_tables", {})).toHaveProperty("error")
  })

  it("covers every station with gate data", () => {
    expect(getStationInfo("ghee kanta").type).toBe("Underground")
    expect(getStationInfo("gift city").lines).toEqual(["Violet Line", "Light Blue Line"])
    expect(gateData().size).toBe(54) // every open station on the /stations-info page
  })

  it("searches the knowledge base", () => {
    expect((searchKnowledgeBase("student pass concession").sections as string[])[0]).toContain("student pass")
    expect(searchKnowledgeBase("xyzzy")).toHaveProperty("result")
  })

  it("gives the model retrieved sections, facts and the time", () => {
    let turn = chat.buildMessages("how can i obtain daily metro pass as student?", []).at(-1)!.content
    expect(turn).toContain("Knowledge base excerpts")
    expect(turn).toContain("does not offer any student pass")
    expect(turn).toContain("Now in Ahmedabad")
    turn = chat.buildMessages("how long from paldi to thaltej", []).at(-1)!.content
    expect(turn).toContain("Facts: Journey Paldi to Thaltej")
  })

  it("retrieves follow-ups with the previous question, and maps history roles", () => {
    const history = [
      { role: "user", text: "is there a student pass?" },
      { role: "bot", text: "No." },
    ]
    expect(chat.buildMessages("and for seniors?", history).at(-1)!.content).toContain("Passes, Student")
    const messages = chat.buildMessages("and the refund?", [
      { role: "user", text: "hi" },
      { role: "bot", text: "Hello" },
    ])
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
  })

  it("keeps Light Blue apart from Blue", () => {
    expect(getLineStations("light blue").line).toBe("Light Blue Line")
    expect(getLineStations("blue line").line).toBe("Blue Line")
    expect(getJourney("Paldi", "Airport").fare_rupees).toBe("not published yet (work in progress)")
  })
})

// ---------------------------------------------------------------- what the rider gets when things fail

describe("failures the rider sees", () => {
  it("falls back to the knowledge base during a model outage", async () => {
    install(Object.fromEntries(MODELS.map((m) => [m, [apiError("unavailable")]])))
    const result = await answer("what is the refund policy for tickets")
    expect(result.source).toBe("kb")
    expect(result.response).toContain("Refund")
  })

  it.each([
    ["how can i obtain daily metro pass as student?", "student pass"],
    ["is there a monthly pass", "monthly pass"],
    ["can I take my bicycle on the train", "Bicycles"],
    ["I lost my bag in the train", "Lost & Found Office"],
    ["smart card deposit refund", "security deposit"],
    ["customer care phone number", "22960123"],
    ["can i take my dog", "Pets"],
    ["penalty without ticket", "Rs 50 plus the maximum fare"],
  ])("answers %j from the right section during an outage", async (question, expected) => {
    install(Object.fromEntries(MODELS.map((m) => [m, [apiError("unavailable")]])))
    const result = await answer(question)
    expect(result.source).toBe("kb")
    expect(result.response).toContain(expected)
  })

  it("raises when an outage has no knowledge-base match", async () => {
    install(Object.fromEntries(MODELS.map((m) => [m, [apiError("unavailable")]])))
    await expect(answer("xyzzy plugh")).rejects.toBeInstanceOf(chat.ChatServiceError)
  })

  it("does not hide a bad key behind the fallback", async () => {
    install(Object.fromEntries(MODELS.map((m) => [m, [apiError("unauthenticated")]])))
    const error = await answer("what is the refund policy").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(chat.ChatServiceError)
    expect((error as chat.ChatServiceError).kind).toBe("config")
  })

  it("treats a missing key as a config error", async () => {
    await expect(answer("what is the refund policy", [], "")).rejects.toBeInstanceOf(chat.ChatServiceError)
  })

  it("keeps what was said when an answer is cut off, and never caches it", async () => {
    install({ "model-a": [[textChunk("Unused tickets are"), apiError("internal")]] })
    const result = await answer("what is the refund policy")
    expect(result.response.startsWith("Unused tickets are")).toBe(true)
    expect(result.response).toContain(INTERRUPTED.en)
    expect(await chat.cacheGet("what is the refund policy")).toBeNull()
  })

  it("answers repeated standalone questions from the cache", async () => {
    const s = install({ "model-a": [[textChunk("25 kg")]] })
    expect((await answer("What is the luggage limit?")).source).toBe("llm")
    expect(await answer("what is the luggage limit")).toEqual({ response: "25 kg", source: "cache" })
    expect(s.calls).toHaveLength(1)
  })

  it("never caches questions about now", async () => {
    const s = install({ "model-a": [[textChunk("Yes, open until 11 PM.")]] })
    await answer("is the metro open now")
    await answer("is the metro open now")
    expect(s.calls).toHaveLength(2)
  })

  it("survives a bug in the rules layer", async () => {
    chat.layers.answerWithRules = () => {
      throw new Error("bug")
    }
    install({ "model-a": [[textChunk("from model")]] })
    expect((await answer("anything")).response).toBe("from model")
  })
})
