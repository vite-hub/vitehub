import { defineQueue } from "vite-hub/queue"
import { runSandbox } from "vite-hub/sandbox"

export default defineQueue(async () => {
  const response = await runSandbox("image-optimizer", { queued: true })
  const result = await response.clone().json()
  const error = response.ok ? undefined : (result as { error: { code: string, message: string } }).error
  if (error?.message.includes('Unknown sandbox "image-optimizer"'))
    throw new Error(error.message)
  ;(globalThis as Record<string, unknown>).__vitehubQueueSandboxResult = response.ok
    ? result
    : { code: error?.code, message: error?.message }
  return response
})
