import { defineHandler, readBody } from "h3"
import { startWorkflow } from "vite-hub/workflow"

export default defineHandler(async (event) => {
  const { token } = await readBody<{ token: string }>(event) ?? { token: "" }
  const [error, run] = await startWorkflow("echo", { token })
  if (error) throw error
  return { id: run.id }
})
