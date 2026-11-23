import { defineHandler } from "h3"
import { runAgent } from "vite-hub/agent"
import hello from "../agents/hello"

export default defineHandler(async () => {
  const [error] = await runAgent(hello, { prompt: "Hello" })
  if (error) throw error
  return { ok: true }
})
