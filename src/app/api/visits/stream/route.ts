import { SSE_HEADERS, sse } from "@/server/http"
import { counter } from "@/server/visits"

export const dynamic = "force-dynamic"
export const maxDuration = 60 // seconds; a stream left behind by a refresh dies soon, the footer reconnects by itself

/**
 * GET /api/visits/stream?id=<tab id>: server-sent events, { total, online } now and after every change, a
 * heartbeat comment between. The same id is one person online however many streams it has open.
 */
export function GET(request: Request) {
  const left = new AbortController()
  request.signal.addEventListener("abort", () => left.abort())
  const id = new URL(request.url).searchParams.get("id")
  const events = counter().stream(left.signal, id && /^[\w-]{8,64}$/.test(id) ? `tab:${id}` : undefined)
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
