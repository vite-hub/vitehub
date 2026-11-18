import { defineEventHandler, getRouterParam } from 'h3'
import { getWorkflowRun as readRun } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  return readRun('onboard-user', getRouterParam(event, 'id')!)
})
