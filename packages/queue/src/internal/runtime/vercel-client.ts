import { createVercelQueueClient } from "../../providers/vercel.ts"

import type { QueueClient, QueueProviderOptions } from "../../types.ts"

export async function createVercelQueueRuntimeClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider !== "vercel") {
    throw new TypeError("[vitehub] Vercel Queue runtime received a non-Vercel provider.")
  }
  return await createVercelQueueClient(options)
}
