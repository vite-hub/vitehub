import { defineWorkflow } from "vite-hub/workflow"

import { instance, record } from "../oracle"

export default defineWorkflow("echo", async (payload: { token: string }) => {
  await record("workflow", payload.token)
  return { instance, token: payload.token }
})
