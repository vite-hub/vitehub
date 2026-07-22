import { defineQueue } from "vite-hub/queue"
import { runSandbox } from "vite-hub/sandbox"

export default defineQueue(async () => {
  const [error, result] = await runSandbox("image-optimizer", { queued: true })
  if (error?.message.includes('Unknown sandbox "image-optimizer"'))
    throw error
  ;(globalThis as Record<string, unknown>).__vitehubQueueSandboxResult = error
    ? { code: error.code, message: error.message }
    : result
})
