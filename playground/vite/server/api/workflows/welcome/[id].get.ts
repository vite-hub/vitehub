import { defineEventHandler } from "h3"
import { getWorkflowRun } from "@vitehub/workflow"

export default defineEventHandler(async (event) => {
  const id = event.context.params?.id
  return id ? await getWorkflowRun("welcome", id) : { status: "unknown" }
})
