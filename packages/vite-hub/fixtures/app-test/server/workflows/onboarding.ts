import { defineWorkflow } from "vite-hub/workflow"

export default defineWorkflow<{ userId: number }>({
  handler: async ({ payload }) => {
    console.info(`Start the onboarding of user ${payload.userId}.`)
  },
})
