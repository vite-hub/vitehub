import { defineHandler, readBody } from "h3"
import { startWorkflow } from "vite-hub/workflow"

export default defineHandler(async (event) => {
  const { token } = await readBody<{ token: string }>(event) ?? { token: "" }
  const run = await startWorkflow("echo", { token })
  return { id: run.id }
})
