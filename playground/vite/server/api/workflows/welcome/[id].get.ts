import { defineEventHandler } from "h3"
import { getWorkflowRun } from "@vite-hub/workflow"

export default defineEventHandler(async (event) => {
  const id = event.context.params?.id
  if (!id) return { status: "unknown" }
  const [error, run] = await getWorkflowRun("welcome", id)
  if (error) throw error
  return run
})
