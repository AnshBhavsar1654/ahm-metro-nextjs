import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The chatbot reads its knowledge base from disk at runtime; ship it with the chat route.
  outputFileTracingIncludes: {
    "/api/chat/stream": ["./src/data/metro_kb.txt"],
  },
  async rewrites() {
    // Short alias for the health check; the chat widget calls it to wake the server.
    return [{ source: "/health", destination: "/api/health" }]
  },
}

export default nextConfig
