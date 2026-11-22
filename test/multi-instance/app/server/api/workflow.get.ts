import { defineHandler, getQuery } from "h3"
import { getWorkflowRun } from "vite-hub/workflow"

export default defineHandler(async (event) => {
  const [error, run] = await getWorkflowRun("echo", String(getQuery(event).id))
  if (error) throw error
  const result = run.result instanceof Response ? await run.result.json() : run.result ?? null
  return { result, status: run.status }
})
