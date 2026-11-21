import { defineWorkflow } from "@vite-hub/workflow"

export default defineWorkflow<{ email?: string, marker?: string } | undefined>({
  handler: async ({ payload }) => {
    return {
      email: payload?.email || "ava@example.com",
      marker: payload?.marker,
      ok: true,
    }
  },
})
