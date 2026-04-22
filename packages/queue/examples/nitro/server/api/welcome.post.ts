import { runQueue } from "@vitehub/queue"
import type { WelcomeEmailPayload } from "../queues/welcome-email"

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomeEmailPayload>(event)

  // Use deferQueue("welcome-email", payload) when you do not need a promise.
  return { ok: true, payload, result: await runQueue("welcome-email", payload) }
})
