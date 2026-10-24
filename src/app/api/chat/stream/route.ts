import { NextResponse } from "next/server"
import { ChatServiceError, answerStream, type ChatEvent } from "@/domain/chat/assistant"
import {
  SSE_HEADERS,
  ValidationError,
  clientIp,
  errorResponse,
  jsonBody,
  sse,
  stringField,
  validationResponse,
} from "@/server/http"
import { store } from "@/server/store"

export const dynamic = "force-dynamic"
export const maxDuration = 60 // seconds; the model race gives up after 30

const MAX_CHAT_MESSAGE_CHARS = 1000

const CHAT_ERROR_MESSAGES = {
  config: "The assistant isn't set up correctly right now. Please try again later.",
  rate_limit: "The assistant is getting a lot of questions right now. Please try again in a minute.",
  unavailable: "The assistant is unavailable right now. Please try again shortly.",
  too_many: "You're sending messages very quickly. Please wait a moment and try again.",
}

// Per-client limit, so one script or stuck client can't use up the model quota for everyone.
const limitPerMinute = (): number => Number.parseInt(process.env.CHAT_LIMIT_PER_MINUTE ?? "20", 10) || 20

function chatError(exc: unknown): NextResponse {
  const kind = exc instanceof ChatServiceError ? exc.kind : "unavailable"
  console.log(`[ERROR /api/chat] ${kind}: ${exc instanceof Error ? exc.message : String(exc)}`)
  const status = { rate_limit: 429, config: 503, unavailable: 503 }[kind]
  return NextResponse.json({ error: CHAT_ERROR_MESSAGES[kind] }, { status })
}

/**
 * POST /api/chat/stream { message, history }: server-sent events, { type: "delta", text } pieces, then
 * { type: "done", source }. Failures before the first piece get a normal JSON error with a status code.
 */
export async function POST(request: Request) {
  let message: string
  let history: unknown[]
  try {
    const body = await jsonBody(request)
    message = stringField(body, "message").trim()
    const raw = body.history ?? []
    if (!Array.isArray(raw) || raw.some((h) => typeof h !== "object" || h === null || Array.isArray(h))) {
      throw new ValidationError("history: Input should be a valid list of objects")
    }
    history = raw
  } catch (exc) {
    if (exc instanceof ValidationError) return validationResponse(exc)
    throw exc
  }
  if (!message) return errorResponse("Missing message")
  if (message.length > MAX_CHAT_MESSAGE_CHARS)
    return errorResponse(`Message is too long (limit ${MAX_CHAT_MESSAGE_CHARS} characters)`)
  if (!(await store().hit(`chat:ip:${clientIp(request)}`, 60, limitPerMinute()))) {
    return errorResponse(CHAT_ERROR_MESSAGES.too_many, 429)
  }

  const started = performance.now()
  const events = answerStream(message, process.env.GEMINI_API_KEY ?? "", history)
  let first: IteratorResult<ChatEvent>
  try {
    first = await events.next()
  } catch (exc) {
    return chatError(exc)
  }
  const firstAt = (performance.now() - started) / 1000

  const encoder = new TextEncoder()
  let source: string | null = null
  let pending: ChatEvent | null = first.done ? null : first.value
  const finish = async () => {
    await events.return(undefined)
    console.log(
      `[chat] ${source ?? "aborted"} streamed in ${((performance.now() - started) / 1000).toFixed(2)}s ` +
        `(first piece after ${firstAt.toFixed(2)}s)`,
    )
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const event = pending ?? (await events.next()).value
        pending = null
        if (!event) {
          controller.close()
          await finish()
          return
        }
        if (event.type === "done") source = event.source
        controller.enqueue(encoder.encode(sse(event)))
      } catch (exc) {
        console.error(exc)
        controller.close()
        await finish()
      }
    },
    async cancel() {
      await finish() // the rider closed the chat: stop the model
    },
  })
  return new Response(body, { headers: SSE_HEADERS })
}
