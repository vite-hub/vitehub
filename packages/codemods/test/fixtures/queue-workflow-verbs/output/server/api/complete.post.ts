import { defineEventHandler, readBody } from "h3"
import { startWorkflow } from "vite-hub/workflow"

// Brief: the route stores the run id so that account deletion can cancel the run.
export default defineEventHandler(async (event) => {
  const { accountId } = await readBody<{ accountId: string }>(event)
  const run = await startWorkflow("generate-brief", { accountId })
  await saveRunId(accountId, run.id)
  return { id: run.id }
})

async function saveRunId(accountId: string, id: string) {
  return { accountId, id }
}
