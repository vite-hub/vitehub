import { createVercelQueueClient } from "../../providers/vercel.ts"

import type { QueueClient, QueueProviderOptions } from "../../types.ts"
import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

export async function createVercelQueueRuntimeClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider !== "vercel") {
    throw queueErrorDiagnostics.QUEUE_R0007({ message: "[vitehub] Vercel Queue runtime received a non-Vercel provider." })
  }
  return await createVercelQueueClient(options)
}
