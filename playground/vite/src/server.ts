import { H3, getRequestURL, readValidatedBody } from "h3"
import * as v from "valibot"

import { deferQueue, runQueue } from "@vitehub/queue"
import { deferWorkflow, runWorkflow } from "@vitehub/workflow"
import { resolveTrustedMarkerCallbackUrl, runInBackground } from "../../_shared/queue-test"

const app = new H3()
const queueMarkers = new Set<string>()
const queueName = "welcome-email"
const workflowMarkers = new Set<string>()
const workflowName = "welcome"
const queueBody = v.optional(v.object({
  callbackUrl: v.optional(v.string()),
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})
const markerBody = v.object({
  marker: v.string(),
})

function resolveTrustedWorkflowMarkerCallbackUrl(requestUrl: URL, callbackUrl: string | undefined) {
  if (!callbackUrl) {
    return undefined
  }
  const resolved = new URL(callbackUrl, requestUrl)
  if (resolved.origin !== requestUrl.origin || resolved.pathname !== "/api/tests/workflow") {
    return undefined
  }
  if (resolved.search || resolved.hash) {
    return undefined
  }
  return resolved.toString()
}

app.get("/", () => ({ ok: true, queue: queueName, workflow: workflowName }))

app.get("/api/queues/welcome", () => ({ ok: true, queue: queueName }))

app.post("/api/queues/welcome", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  const callbackUrl = marker ? resolveTrustedMarkerCallbackUrl(getRequestURL(event), body?.callbackUrl) : undefined
  return {
    ok: true,
    result: await runQueue(queueName, {
      email: body?.email || "ava@example.com",
      callbackUrl,
      marker,
    }),
  }
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

  if (!runInBackground(event, () => runQueue(queueName, payload))) {
    deferQueue(queueName, payload)
  }
  return { ok: true }
})

app.get("/api/tests/queue", async (event) => {
  const marker = event.req.query?.marker
  return {
    ok: true,
    seen: typeof marker === "string" && marker.length > 0 ? queueMarkers.has(marker) : false,
  }
})

app.post("/api/tests/queue", async (event) => {
  const body = await readValidatedBody(event, markerBody)
  queueMarkers.add(body.marker)
  return { ok: true }
})

app.get("/api/workflows/welcome", () => ({ ok: true, workflow: workflowName }))

app.post("/api/workflows/welcome", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  const callbackUrl = marker ? resolveTrustedWorkflowMarkerCallbackUrl(getRequestURL(event), body?.callbackUrl) : undefined
  return {
    ok: true,
    result: await runWorkflow(workflowName, {
      email: body?.email || "ava@example.com",
      callbackUrl,
      marker,
    }),
  }
})

app.post("/api/workflows/welcome-defer", async (event) => {
  const body = await readValidatedBody(event, queueBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  const callbackUrl = marker ? resolveTrustedWorkflowMarkerCallbackUrl(getRequestURL(event), body?.callbackUrl) : undefined
  const payload = {
    email: body?.email || "ava@example.com",
    callbackUrl,
    marker,
  }

  if (!runInBackground(event, () => runWorkflow(workflowName, payload))) {
    deferWorkflow(workflowName, payload)
  }
  return { ok: true }
})

app.get("/api/tests/workflow", async (event) => {
  const marker = event.req.query?.marker
  return {
    ok: true,
    seen: typeof marker === "string" && marker.length > 0 ? workflowMarkers.has(marker) : false,
  }
})

app.post("/api/tests/workflow", async (event) => {
  const body = await readValidatedBody(event, markerBody)
  workflowMarkers.add(body.marker)
  return { ok: true }
})

export default app
