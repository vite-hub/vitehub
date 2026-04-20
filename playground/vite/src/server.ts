import { H3, readValidatedBody } from "h3"
import * as v from "valibot"

import { deferQueue, runQueue } from "@vitehub/queue"

const app = new H3()
const queueName = "welcome-email"
const queueBody = v.optional(v.object({
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})

app.get("/", () => ({ ok: true, queue: queueName }))

app.get("/api/queues/welcome", () => ({ ok: true, queue: queueName }))

app.post("/api/queues/welcome", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  return {
    ok: true,
    result: await runQueue(queueName, {
      email: body?.email || "ava@example.com",
      marker,
    }),
  }
})

app.post("/api/queues/welcome-defer", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  deferQueue(queueName, {
    email: body?.email || "ava@example.com",
    marker,
  })
  return { ok: true }
})

export default app
