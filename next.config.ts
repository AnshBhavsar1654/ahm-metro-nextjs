import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The chatbot reads its knowledge base from disk at runtime; ship it with the chat route.
  outputFileTracingIncludes: {
    "/api/chat/stream": ["./src/data/metro_kb.txt"],
  },
  async rewrites() {
    // FastAPI served GET /health; the keep-alive ping and the chat widget's warm-up still use it.
    return [{ source: "/health", destination: "/api/health" }]
  },
}

export default nextConfig
