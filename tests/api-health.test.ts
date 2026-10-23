import { describe, expect, it } from "vitest"
import { GET } from "@/app/api/health/route"

// Matches FastAPI's GET /health: {"status": "ok"} (backend/app.py).
describe("GET /api/health", () => {
  it("returns ok", async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })
})
