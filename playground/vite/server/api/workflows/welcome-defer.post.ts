import { defineEventHandler, getRequestURL, readValidatedBody } from "h3"
import * as v from "valibot"
import { deferWorkflow, runWorkflow } from "@vitehub/workflow"
import { runInBackground } from "../../../../_shared/queue-test"
import { resolveTrustedWorkflowMarkerCallbackUrl } from "../../../../_shared/workflow-test"

const workflowName = "welcome"
const workflowBody = v.optional(v.object({
  callbackUrl: v.optional(v.string()),
  email: v.optional(v.string()),
  marker: v.optional(v.string()),
}), {})

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, workflowBody)
  const marker = typeof body?.marker === "string" ? body.marker : event.headers.get("x-vitehub-e2e-marker") || undefined
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
