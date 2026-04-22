import { H3, readBody } from "h3"

import { runQueue } from "@vitehub/queue"
import type { WelcomeEmailPayload } from "./welcome-email.queue"

const app = new H3()

app.post("/api/welcome", async (event) => {
  const payload = await readBody<WelcomeEmailPayload>(event)

  // Use deferQueue("welcome-email", payload) when you do not need a promise.
  return { ok: true, payload, result: await runQueue("welcome-email", payload) }
})

export default app
