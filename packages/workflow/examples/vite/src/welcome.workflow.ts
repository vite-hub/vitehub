import { defineWorkflow } from "@vite-hub/workflow"

export type WelcomePayload = {
  email: string
  marker?: string
}

export default defineWorkflow("welcome", async (payload: WelcomePayload, { id, provider }) => {
  return {
    id,
    marker: payload.marker,
    message: `Welcome ${payload.email}`,
    provider,
  }
})
