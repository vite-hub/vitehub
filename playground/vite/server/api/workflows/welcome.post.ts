import { defineEventHandler, getRequestURL, readValidatedBody } from "h3"
import * as v from "valibot"
import { startWorkflow } from "@vite-hub/workflow"
import { resolveTrustedMarkerCallbackUrl } from "../../../../_shared/queue-test"

const workflowName = "welcome"
const workflowBody = v.optional(v.object({
  callbackUrl: v.optional(v.string()),
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.headers.get("x-vitehub-e2e-marker") || undefined
  const callbackUrl = marker ? resolveTrustedMarkerCallbackUrl(getRequestURL(event), body?.callbackUrl) : undefined
  const [error, run] = await startWorkflow(workflowName, { callbackUrl, email: body?.email || "ava@example.com", marker })
  if (error) throw error
  return { ok: true, result: run }
})
