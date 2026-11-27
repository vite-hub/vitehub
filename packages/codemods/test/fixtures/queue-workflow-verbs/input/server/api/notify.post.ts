import { defineEventHandler, readBody } from "h3"
import { deferQueue, runQueue } from "vite-hub/queue"
import { deferWorkflow, resumeWorkflowSignal, runWorkflow } from "vite-hub/workflow"
import type { WorkflowDeferOptions } from "vite-hub/workflow"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string, token?: string }>(event)
  const options: WorkflowDeferOptions = { id: body.email }
  const [error, result] = await runQueue("welcome-email", { email: body.email }, { delaySeconds: 60 })
  if (error) throw error
  deferQueue("audit", { email: body.email })
  await deferWorkflow("digest", { email: body.email }, options)
  if (body.token) await resumeWorkflowSignal(body.token, { approved: true })
  return { result, run: await runWorkflow("onboard", body) }
})
