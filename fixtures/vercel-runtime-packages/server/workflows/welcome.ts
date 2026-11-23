import { defineWorkflow } from "vite-hub/workflow"

export default defineWorkflow<{ email: string }>({
  handler: async ({ payload }) => ({ sent: payload.email }),
})
