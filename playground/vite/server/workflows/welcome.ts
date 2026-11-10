import { defineWorkflow } from "@vite-hub/workflow"

export default defineWorkflow("welcome", async (payload: { email?: string, marker?: string } | undefined) => {
  return {
    email: payload?.email || "ava@example.com",
    marker: payload?.marker,
    ok: true,
  }
})
