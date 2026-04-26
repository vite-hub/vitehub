import { defineEventHandler, readValidatedBody } from "h3"
import * as v from "valibot"
import { runWorkflow } from "@vitehub/workflow"

const workflowName = "welcome"
const workflowBody = v.optional(v.object({
  email: v.optional(v.string()),
  id: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.headers.get("x-vitehub-e2e-marker") || undefined
  const id = body?.id || marker || `welcome-${Date.now().toString(36)}`
  const payload = {
    email: body?.email || "ava@example.com",
    marker,
  }

  return {
    ok: true,
    result: await runWorkflow(workflowName, { id, payload }),
  }
})
