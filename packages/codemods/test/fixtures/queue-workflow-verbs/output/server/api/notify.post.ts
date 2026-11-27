import { defineEventHandler, readBody } from "h3"
import { deferQueue, sendQueue } from "vite-hub/queue"
import { deferWorkflow, resumeWorkflow, startWorkflow } from "vite-hub/workflow"
import type { WorkflowStartOptions } from "vite-hub/workflow"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string, token?: string }>(event)
  const options: WorkflowStartOptions = { id: body.email }
  const [error, result] = await sendQueue("welcome-email", { email: body.email }, { delaySeconds: 60 })
  if (error) throw error
  deferQueue("audit", { email: body.email })
  deferWorkflow("digest", { email: body.email }, options)
  if (body.token) await resumeWorkflow(body.token, { approved: true })
  return { result, run: await startWorkflow("onboard", body) }
})
