import { runQueue } from "@vitehub/queue"
import type { WelcomeEmailPayload } from "../../queues/welcome-email"

export default defineEventHandler(async (event) => {
  const body = await readBody<Partial<WelcomeEmailPayload>>(event)
  const payload: WelcomeEmailPayload = {
    email: body?.email || "ava@example.com",
    template: body?.template || "default",
  }

  return {
    ok: true,
    payload,
    result: await runQueue("welcome-email", payload),
  }
})
