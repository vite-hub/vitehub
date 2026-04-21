import { defineEventHandler, readValidatedBody } from "h3"
import * as v from "valibot"
import { runInBackground } from "../../../queue-test"

const queueName = "welcome-email"
const queueBody = v.optional(v.object({
  callbackUrl: v.optional(v.string()),
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.headers.get("x-vitehub-e2e-marker") || undefined
  const payload = {
    email: body?.email || "ava@example.com",
    callbackUrl: body?.callbackUrl,
    marker,
  }

  if (!runInBackground(event, runQueue(queueName, payload))) {
    deferQueue(queueName, payload)
  }

  return { ok: true }
})
