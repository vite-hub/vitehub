import { defineEventHandler } from "h3"
import { runQueue } from "@vitehub/queue"

export default defineEventHandler(async () => {
  const result = await runQueue("welcome-email", {
    email: "ava@example.com",
  })
  return { ok: true, result }
})
