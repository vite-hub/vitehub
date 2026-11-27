import { anthropic } from "@ai-sdk/anthropic"
import { runMcpEval } from "vite-hub/mcp/eval"

await runMcpEval({
  server: { url: process.env.MCP_URL ?? "https://vitehub.dev/mcp" },
  cases: new URL("./cases.ndjson", import.meta.url),
  models: {
    sonnet: anthropic("claude-sonnet-5-5"),
    haiku: anthropic("claude-haiku-5-5"),
  },
  argv: process.argv.slice(2).filter(arg => arg !== "--"),
})
