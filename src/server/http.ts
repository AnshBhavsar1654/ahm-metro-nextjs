/**
 * What the route handlers share, carried over from backend/app.py: the { error } response, the
 * client's IP behind a proxy, Server-Sent Events framing, and FastAPI-style request validation
 * (a malformed body or query parameter is a 422, as pydantic made it).
 */
import { NextResponse } from "next/server"

export function errorResponse(message: string, status: number = 400): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

/** Render and Vercel put the real client first in x-forwarded-for. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? ""
  return forwarded.split(",")[0]!.trim() || request.headers.get("x-real-ip") || "unknown"
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
}

export const sse = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`

// ---------------------------------------------------------------- validation

export class ValidationError extends Error {}

export function validationResponse(error: ValidationError): NextResponse {
  return NextResponse.json({ detail: [{ msg: error.message }] }, { status: 422 })
}

/** The JSON body as an object, or a ValidationError (FastAPI: "Field required" / "JSON decode error"). */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new ValidationError("Request body must be JSON")
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new ValidationError("Request body must be a JSON object")
  return body as Record<string, unknown>
}

/** A string field with a default, as `field: str = ""` in a pydantic model. */
export function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (value === undefined || value === null) {
    if (value === null) throw new ValidationError(`${name}: Input should be a valid string`)
    return ""
  }
  if (typeof value !== "string") throw new ValidationError(`${name}: Input should be a valid string`)
  return value
}

const FLOAT = /^\s*[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|inf(?:inity)?|nan)\s*$/i

/** An optional float query parameter (FastAPI `Optional[float] = None`). */
export function floatParam(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name)
  if (raw === null) return null
  if (!FLOAT.test(raw)) throw new ValidationError(`${name}: Input should be a valid number`)
  const text = raw.trim().toLowerCase().replace(/^\+/, "")
  if (/^-?nan$/.test(text)) return Number.NaN
  if (/^-?inf/.test(text)) return text.startsWith("-") ? -Infinity : Infinity
  return Number(text)
}
