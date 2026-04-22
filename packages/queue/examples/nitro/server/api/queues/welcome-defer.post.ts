import { deferQueue } from "@vitehub/queue"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string }>(event)

  deferQueue("welcome-email", {
    email: body?.email || "ava@example.com",
  })

  return { ok: true }
})
