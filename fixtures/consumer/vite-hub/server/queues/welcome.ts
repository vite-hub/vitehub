import { defineQueue } from "vite-hub/queue"
import { runSandboxTask } from "vite-hub/sandbox/task"

export default defineQueue({
  handler: async () => {
    const [error, result] = await runSandboxTask("image-optimizer", { queued: true })
    const failure = error?.cause instanceof Error ? error.cause : undefined
    if (failure?.message.includes('Unknown Sandbox Task "image-optimizer"'))
      throw failure
    ;(globalThis as Record<string, unknown>).__vitehubQueueSandboxTaskResult = error
      ? { code: error.code, message: failure?.message }
      : result
    return result
  },
})
