import { NextResponse } from "next/server"
import { ValidationError, errorResponse, jsonBody, stringField, validationResponse } from "@/server/http"
import { isError, routePayload } from "@/server/metro-api"

export const dynamic = "force-dynamic"

/** POST /api/route { source, destination }: the quickest route, its legs, time, next trains and alternatives. */
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request)
    const result = routePayload(stringField(body, "source"), stringField(body, "destination"))
    return isError(result) ? errorResponse(result.error) : NextResponse.json(result)
  } catch (exc) {
    if (exc instanceof ValidationError) return validationResponse(exc)
    throw exc
  }
}
