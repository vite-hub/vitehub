import { createCloudflareQueueClient } from "../../providers/cloudflare.ts"

import type { QueueClient, QueueProviderOptions } from "../../types.ts"

export async function createCloudflareQueueRuntimeClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider !== "cloudflare") {
    throw new TypeError("[vitehub] Cloudflare Queue runtime received a non-Cloudflare provider.")
  }
  return createCloudflareQueueClient(options)
}
