import { SSE_HEADERS, sse } from "@/server/http"
import { counter } from "@/server/visits"

export const dynamic = "force-dynamic"

/** GET /api/visits/stream: server-sent events, { total, online } now and after every change, a heartbeat comment between. */
export function GET(request: Request) {
  const left = new AbortController()
  request.signal.addEventListener("abort", () => left.abort())
  const events = counter().stream(left.signal)
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next()
      if (next.done) controller.close()
      else controller.enqueue(encoder.encode(next.value ? sse(next.value) : ": ping\n\n"))
    },
    async cancel() {
      left.abort()
      await events.return(undefined)
    },
  })
  return new Response(body, { headers: SSE_HEADERS })
}
