import { defineEventHandler, readBody } from 'h3'
import { startWorkflow } from 'vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)
  const run = await startWorkflow('onboard-user', body)
  return { id: run.id }
})
