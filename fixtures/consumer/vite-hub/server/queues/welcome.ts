import { defineQueue } from "vite-hub/queue"
import { runSandbox } from "vite-hub/sandbox"

export default defineQueue(async () => {
  const result = await runSandbox("image-optimizer", { queued: true })
  if (result.error?.message.includes('Unknown sandbox "image-optimizer"'))
    throw result.error
  ;(globalThis as Record<string, unknown>).__vitehubQueueSandboxResult = result.error
    ? { code: result.error.code, message: result.error.message }
    : result.value
})
