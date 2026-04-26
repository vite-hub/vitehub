import { H3, getRequestURL, readValidatedBody } from "h3"
import * as v from "valibot"

import { deferWorkflow, runWorkflow } from "@vitehub/workflow"
import { runInBackground } from "../../_shared/queue-test"
import { resolveTrustedWorkflowMarkerCallbackUrl } from "../../_shared/workflow-test"

const app = new H3()
const workflowMarkers = new Set<string>()
const workflowName = "welcome"
const workflowBody = v.optional(v.object({
  callbackUrl: v.optional(v.string()),
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})
const markerBody = v.object({
  marker: v.string(),
})

app.get("/", () => ({ ok: true, workflow: workflowName }))

app.get("/api/workflows/welcome", () => ({ ok: true, workflow: workflowName }))

app.post("/api/workflows/welcome", async (event) => {
  const body = await readValidatedBody(event, workflowBody)
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
  const body = await readValidatedBody(event, workflowBody)
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
