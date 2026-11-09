import { defineWorkflow } from "vite-hub/workflow"

import { instance, record } from "../oracle"

export default defineWorkflow<{ token: string }>(async ({ payload }) => {
  await record("workflow", payload.token)
  return { instance, token: payload.token }
})
