import { defineEventHandler, readValidatedBody } from "h3"
import * as v from "valibot"

const queueName = "welcome-email"
const queueBody = v.optional(v.object({
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.headers.get("x-vitehub-e2e-marker") || undefined

  deferQueue(queueName, {
    email: body?.email || "ava@example.com",
    marker,
  })

  return { ok: true }
})
