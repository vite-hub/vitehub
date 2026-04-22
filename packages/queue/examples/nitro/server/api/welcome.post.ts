import { deferQueue, runQueue } from "@vitehub/queue"
import type { WelcomeEmailPayload } from "../queues/welcome-email"

type WelcomeRequestBody = Partial<WelcomeEmailPayload> & {
  defer?: boolean
}

export default defineEventHandler(async (event) => {
  const body = await readBody<WelcomeRequestBody>(event)
  const payload: WelcomeEmailPayload = {
    email: body?.email || "ava@example.com",
    template: body?.template || "default",
  }

  if (body?.defer) {
    deferQueue("welcome-email", payload)

    return {
      deferred: true,
      ok: true,
      payload,
    }
  }

  return {
    ok: true,
    payload,
    result: await runQueue("welcome-email", payload),
  }
})
