import { createVercelQueueClient } from "../../providers/vercel.ts"

import type { QueueClient, QueueDriverOptions } from "../../types.ts"
import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

export async function createVercelQueueRuntimeClient(options: QueueDriverOptions): Promise<QueueClient> {
  if (options.driver !== "vercel") {
    throw queueErrorDiagnostics.QUEUE_DRIVER_MISMATCH({ driver: options.driver, expected: "vercel" })
  }
  return await createVercelQueueClient(options)
}
