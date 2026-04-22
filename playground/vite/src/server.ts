import { H3, readValidatedBody } from "h3"
import * as v from "valibot"

import { deferQueue, runQueue } from "@vitehub/queue"
import { kv } from "@vitehub/kv"
import { runInBackground } from "../../_shared/queue-test"

const app = new H3()
const queueName = "welcome-email"
const queueBody = v.optional(v.object({
  callbackUrl: v.optional(v.string()),
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})
const markerBody = v.object({
  marker: v.string(),
})

app.get("/", () => ({ ok: true, queue: queueName }))

app.get("/api/queues/welcome", () => ({ ok: true, queue: queueName }))

app.post("/api/queues/welcome", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  return {
    ok: true,
    result: await runQueue(queueName, {
      email: body?.email || "ava@example.com",
      callbackUrl: body?.callbackUrl,
      marker,
    }),
  }
})

app.post("/api/queues/welcome-defer", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  const payload = {
    email: body?.email || "ava@example.com",
    callbackUrl: body?.callbackUrl,
    marker,
  }

  if (!runInBackground(event, () => runQueue(queueName, payload))) {
    deferQueue(queueName, payload)
  }
  return { ok: true }
})

app.get("/api/tests/queue", async (event) => {
  const marker = event.req.query?.marker
  const key = typeof marker === "string" && marker.length > 0
    ? `queue-e2e:${marker}`
    : ""

  return {
    ok: true,
    seen: key ? await kv.has(key) : false,
  }
})

app.post("/api/tests/queue", async (event) => {
  const body = await readValidatedBody(event, markerBody)
  await kv.set(`queue-e2e:${body.marker}`, true)
  return { ok: true }
})

export default app
