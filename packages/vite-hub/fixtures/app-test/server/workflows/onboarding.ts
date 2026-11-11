import { defineWorkflow } from "vite-hub/workflow"

export default defineWorkflow("onboarding", async (payload: { userId: number }) => {
  console.info(`Start the onboarding of user ${payload.userId}.`)
})
