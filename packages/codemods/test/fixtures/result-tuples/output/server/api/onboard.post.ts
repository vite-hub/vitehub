import { defineEventHandler, readBody } from 'h3'
import { startWorkflow } from 'vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)
  const [runError, run] = await startWorkflow('onboard-user', body)
  if (runError) throw runError
  return { id: run.id }
})
