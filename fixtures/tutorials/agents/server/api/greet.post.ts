import { defineEventHandler, readBody } from "h3"
import { runAgent } from "vite-hub/agent"

import greeting from "../agents/greeting"

export default defineEventHandler(async (event) => {
  const { name } = await readBody<{ name?: string }>(event) || {}
  const [error, result] = await runAgent(greeting, { prompt: name?.trim() || "friend" })
  if (error) throw error
  return result
})
