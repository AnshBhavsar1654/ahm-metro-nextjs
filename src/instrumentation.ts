/** Runs once when the Next.js server starts (FastAPI's lifespan in backend/app.py). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startKeepalive } = await import("./server/keepalive")
    startKeepalive()
  }
}
