import { createCloudflareQueueClient } from "../../providers/cloudflare.ts"

import type { QueueClient, QueueProviderOptions } from "../../types.ts"
import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

export async function createCloudflareQueueRuntimeClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider !== "cloudflare") {
    throw queueErrorDiagnostics.QUEUE_PROVIDER_MISMATCH({ expected: "cloudflare", provider: options.provider })
  }
  return createCloudflareQueueClient(options)
}
