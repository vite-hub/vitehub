import { runWorkflow } from "@vite-hub/workflow"
import type { WelcomePayload } from "../workflows/welcome"

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomePayload>(event)
  const run = await runWorkflow("welcome", payload)

  return { ok: true, payload, run }
})
