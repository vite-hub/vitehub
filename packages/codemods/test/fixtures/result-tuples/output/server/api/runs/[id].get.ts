import { defineEventHandler, getRouterParam } from 'h3'
import { getWorkflowRun as readRun } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const [error, run] = await readRun('onboard-user', getRouterParam(event, 'id')!)
  if (error) throw error
  return run
})
