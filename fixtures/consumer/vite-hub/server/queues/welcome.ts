import { defineQueue } from "vite-hub/queue"
import { runSandboxTask } from "vite-hub/sandbox-task"

export default defineQueue(async () => {
  const response = await runSandboxTask("image-optimizer", { queued: true })
  const result = await response.clone().json()
  const error = response.ok ? undefined : (result as { error: { code: string, message: string } }).error
  if (error?.message.includes('Unknown Sandbox Task "image-optimizer"'))
    throw new Error(error.message)
  ;(globalThis as Record<string, unknown>).__vitehubQueueSandboxTaskResult = response.ok
    ? result
    : { code: error?.code, message: error?.message }
  return response
})
