import { runWorkflow } from "@vitehub/workflow"
import type { WelcomePayload } from "../workflows/welcome"

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomePayload>(event)
  const run = await runWorkflow("welcome", payload)

  return { ok: true, payload, run }
})
