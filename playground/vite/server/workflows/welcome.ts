import { defineWorkflow } from "@vite-hub/workflow"

export default defineWorkflow(async ({ payload }) => {
  const body = payload as { email?: string, marker?: string } | undefined

  return {
    email: body?.email || "ava@example.com",
    marker: body?.marker,
    ok: true,
  }
})
