import { H3, readBody } from "h3"

import { getWorkflowRun, runWorkflow } from "@vitehub/workflow"
import type { WelcomePayload } from "./welcome.workflow"

const app = new H3()

app.post("/api/welcome", async (event) => {
  const payload = await readBody<WelcomePayload>(event)
  const run = await runWorkflow("welcome", payload)

  return { ok: true, payload, run }
})

app.get("/api/workflow/:id", async (event) => {
  const id = event.context.params?.id
  return id ? await getWorkflowRun("welcome", id) : { status: "unknown" }
})

export default app
