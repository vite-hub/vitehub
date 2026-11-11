import { defineEventHandler, readValidatedBody } from "h3"
import * as v from "valibot"
import { deferWorkflow } from "@vite-hub/workflow"

const workflowName = "welcome"
const workflowBody = v.optional(v.object({
  email: v.optional(v.string()),
  id: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.headers.get("x-vitehub-e2e-marker") || undefined
  // `deferWorkflow()` returns nothing, so the route picks the run ID that the caller polls.
  const id = body?.id || marker || crypto.randomUUID()
  deferWorkflow(workflowName, { email: body?.email || "ava@example.com", marker }, { id })
  return { ok: true, result: { id } }
})
