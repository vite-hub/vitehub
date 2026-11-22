import { startOpenWorkflowWorker } from "@vite-hub/workflow/openworkflow"
import { definePlugin } from "nitro"

import { record } from "../oracle"

export default definePlugin(() => {
  setTimeout(() => {
    startOpenWorkflowWorker().then(
      () => record("worker", "started"),
      async (error: unknown) => {
        console.error("[multi-instance] OpenWorkflow worker failed to start", error)
        await record("worker", "failed")
      },
    )
  }, 0)
})
