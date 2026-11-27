import { defineEventHandler, readBody } from "h3"
import { deferWorkflow, startWorkflow } from "@vite-hub/workflow"

export default defineEventHandler(async (event) => {
  const { accountId } = await readBody<{ accountId: string }>(event)
  deferWorkflow("audit", { accountId })
  return await startWorkflow("generate-brief", { accountId }, { id: `brief-${accountId}` })
})
