import { createCloudflareQueueClient } from "../../providers/cloudflare.ts"

import type { QueueClient, QueueDriverOptions } from "../../types.ts"
import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

export async function createCloudflareQueueRuntimeClient(options: QueueDriverOptions): Promise<QueueClient> {
  if (options.driver !== "cloudflare") {
    throw queueErrorDiagnostics.QUEUE_DRIVER_MISMATCH({ driver: options.driver, expected: "cloudflare" })
  }
  return createCloudflareQueueClient(options)
}
