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

app.get("/", () => ({ ok: true, workflow: workflowName }))

app.get("/api/workflows/welcome", () => ({ ok: true, workflow: workflowName }))

app.post("/api/workflows/welcome", async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  const id = body?.id || marker
  return {
    ok: true,
    result: await runWorkflow(workflowName, {
      id,
      payload: {
        email: body?.email || "ava@example.com",
        marker,
      },
    }),
  }
})

app.post("/api/workflows/welcome-defer", async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.req.headers.get("x-vitehub-e2e-marker") || undefined
  const id = body?.id || marker || `welcome-${Date.now().toString(36)}`
  const payload = {
    email: body?.email || "ava@example.com",
    marker,
  }

  deferWorkflow(workflowName, { id, payload })
  return {
    ok: true,
    result: {
      id,
      status: "queued",
    },
  }
})

app.get("/api/workflows/welcome/:id", async (event) => {
  const id = event.context.params?.id
  return id ? await getWorkflowRun(workflowName, id) : { status: "unknown" }
})

export default app
