import { H3, readValidatedBody } from "h3"
import * as v from "valibot"

import { deferWorkflow, getWorkflowRun, runWorkflow } from "@vitehub/workflow"

const app = new H3()
const workflowName = "welcome"
const workflowBody = v.optional(v.object({
  email: v.optional(v.string()),
  id: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})

function resolveId(body: { id?: string, marker?: string }, marker: string | undefined) {
  return body?.id || marker
}

function buildPayload(body: { email?: string, marker?: string }, marker: string | undefined) {
  return { email: body?.email || "ava@example.com", marker }
}

app.get("/", () => ({ ok: true, workflow: workflowName }))
app.get("/api/workflows/welcome", () => ({ ok: true, workflow: workflowName }))

app.post("/api/workflows/welcome", async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  return {
    ok: true,
    result: await runWorkflow(workflowName, buildPayload(body, marker), { id: resolveId(body, marker) }),
  }
})

app.post("/api/workflows/welcome-defer", async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  return {
    ok: true,
    result: await deferWorkflow(workflowName, buildPayload(body, marker), { id: resolveId(body, marker) }),
  }
})

app.get("/api/workflows/welcome/:id", async (event) => {
  const id = event.context.params?.id
  return id ? await getWorkflowRun(workflowName, id) : { status: "unknown" }
})

export default app
