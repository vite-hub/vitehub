import { defineWorkflow } from "vite-hub/workflow"

export default defineWorkflow<{ userId: number }>(async ({ payload }) => {
  console.info(`Start the onboarding of user ${payload.userId}.`)
})
