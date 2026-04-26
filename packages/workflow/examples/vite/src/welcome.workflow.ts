import { defineWorkflow } from "@vitehub/workflow"

export type WelcomePayload = {
  email: string
  marker?: string
}

export default defineWorkflow<WelcomePayload>(async ({ id, payload, provider }) => {
  return {
    id,
    marker: payload.marker,
    message: `Welcome ${payload.email}`,
    provider,
  }
})
