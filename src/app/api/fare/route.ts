import { NextResponse } from "next/server"
import { ValidationError, errorResponse, jsonBody, stringField, validationResponse } from "@/server/http"
import { farePayload, isError } from "@/server/metro-api"

/** POST /api/fare { source, destination }: { fare } (null while a station is work in progress). */
export async function POST(request: Request) {
  try {
    const body = await jsonBody(request)
    const result = farePayload(stringField(body, "source"), stringField(body, "destination"))
    return isError(result) ? errorResponse(result.error) : NextResponse.json(result)
  } catch (exc) {
    if (exc instanceof ValidationError) return validationResponse(exc)
    throw exc
  }
}
