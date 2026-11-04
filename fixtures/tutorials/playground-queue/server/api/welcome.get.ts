import { defineEventHandler, getQuery } from "h3"
import { runQueue } from "vite-hub/queue"

export default defineEventHandler(async (event) => {
  const { email = "ada@example.com" } = getQuery<{ email?: string }>(event)

  const [error, result] = await runQueue("welcome-email", { email })
  if (error) throw error
  return { email, status: result.status }
})
