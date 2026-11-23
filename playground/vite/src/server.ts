import { H3, getRequestURL, readValidatedBody } from "h3"
import * as v from "valibot"

import { kv } from "@vite-hub/kv"
import { deferQueue, sendQueue } from "@vite-hub/queue"
import { getQueueMarkerKey, queueMarkerStages, resolveTrustedMarkerCallbackUrl, runInBackground } from "../../_shared/queue-test"
import { scheduleMarkerKey } from "./schedule-marker"

const app = new H3()
const queueMarkers = new Map<string, string | true>()
const queueName = "welcome-email"
const queueBody = v.optional(v.object({
  callbackUrl: v.optional(v.string()),
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})
const markerBody = v.object({
  error: v.optional(v.string()),
  marker: v.string(),
  stage: v.optional(v.picklist(queueMarkerStages), "done"),
})

app.get("/", () => ({ ok: true, queue: queueName, schedule: "daily-marker" }))

app.get("/api/queues/welcome", () => ({ ok: true, queue: queueName }))

app.post("/api/queues/welcome", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  const callbackUrl = marker ? resolveTrustedMarkerCallbackUrl(getRequestURL(event), body?.callbackUrl) : undefined
  const [error, result] = await sendQueue(queueName, {
    email: body?.email || "ava@example.com",
    callbackUrl,
    marker,
  })
  if (error) throw error
  return { ok: true, result }
})

app.post("/api/queues/welcome-defer", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  const callbackUrl = marker ? resolveTrustedMarkerCallbackUrl(getRequestURL(event), body?.callbackUrl) : undefined
  const payload = {
    email: body?.email || "ava@example.com",
    callbackUrl,
    marker,
  }

  if (!runInBackground(event, async () => {
    const [error] = await sendQueue(queueName, payload)
    if (error) throw error
  })) {
    deferQueue(queueName, payload)
  }
  return { ok: true }
})

app.get("/api/tests/queue", async (event) => {
  const marker = event.req.query?.marker
  if (typeof marker !== "string" || marker.length === 0) {
    return { error: null, ok: true, received: false, seen: false }
  }
  const failure = queueMarkers.get(getQueueMarkerKey(marker, "failed"))
  return {
    error: typeof failure === "string" ? failure : null,
    ok: true,
    received: queueMarkers.has(getQueueMarkerKey(marker, "received")),
    seen: queueMarkers.has(getQueueMarkerKey(marker, "done")),
  }
})

app.post("/api/tests/queue", async (event) => {
  const body = await readValidatedBody(event, markerBody)
  queueMarkers.set(getQueueMarkerKey(body.marker, body.stage), body.stage === "failed" ? body.error || "unknown error" : true)
  return { ok: true }
})

app.get("/api/tests/schedule", async () => {
  const [error, storedMarker] = await kv.get(scheduleMarkerKey)
  if (error) throw error
  const marker = storedMarker ?? globalThis.__vitehubScheduleMarker
  return {
    ok: true,
    key: scheduleMarkerKey,
    marker,
    seen: Boolean(marker),
  }
})

export default app
