import { defineHandler, getQuery } from "h3"
import { getWorkflowRun } from "vite-hub/workflow"

export default defineHandler(async (event) => {
  const run = await getWorkflowRun("echo", String(getQuery(event).id))
  // A run result is a Response that holds what the Workflow returned.
  const result = run?.result instanceof Response ? await run.result.json() : run?.result ?? null
  return { result, status: run?.status ?? "unknown" }
})
