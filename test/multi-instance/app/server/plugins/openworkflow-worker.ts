import { startOpenWorkflowWorker } from "@vite-hub/workflow/openworkflow"
import { definePlugin } from "nitro"

import { record } from "../oracle"

// ViteHub does not start an OpenWorkflow worker on Node yet, so the app starts one by hand.
// The generated Workflow plugin installs the runtime config, so start after the other plugins ran.
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
