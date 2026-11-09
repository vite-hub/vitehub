import { defineHandler, readBody } from "h3"
import { runWorkflow } from "vite-hub/workflow"

export default defineHandler(async (event) => {
  const { token } = await readBody<{ token: string }>(event) ?? { token: "" }
  const run = await runWorkflow("echo", { token })
  return { id: run.id }
})
