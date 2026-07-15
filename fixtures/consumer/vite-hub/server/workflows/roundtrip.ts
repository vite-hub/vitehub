import { defineWorkflow } from "vite-hub/workflow"

export default defineWorkflow<{ marker: string }, { marker: string }>(async ({ payload }) => ({
  marker: payload.marker,
}))
