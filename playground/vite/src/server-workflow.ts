import { H3, readValidatedBody } from "h3"
import * as v from "valibot"

import { deferWorkflow, getWorkflowRun, startWorkflow } from "@vite-hub/workflow"

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
  const [error, run] = await startWorkflow(workflowName, buildPayload(body, marker), { id: resolveId(body, marker) })
  if (error) throw error
  return { ok: true, result: run }
})

app.post("/api/workflows/welcome-defer", async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  const id = resolveId(body, marker) || crypto.randomUUID()
  deferWorkflow(workflowName, buildPayload(body, marker), { id })
  return { ok: true, result: { id } }
})

app.get("/api/workflows/welcome/:id", async (event) => {
  const id = event.context.params?.id
  if (!id) return { status: "unknown" }
  const [error, run] = await getWorkflowRun(workflowName, id)
  if (error) throw error
  return run
})

export default app
