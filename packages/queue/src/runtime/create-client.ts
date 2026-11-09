import { getQueueRuntimeClientFactory } from "../internal/runtime/state.ts"

import type { QueueClient, QueueProviderOptions } from "../types.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"

export async function createQueueClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider === "cloudflare") {
    const { createCloudflareQueueRuntimeClient } = await import("../internal/runtime/cloudflare-client.ts")
    return await createCloudflareQueueRuntimeClient(options)
  }

  if (options.provider === "local") {
    const { createLocalQueueRuntimeClient } = await import("../internal/runtime/local-client.ts")
    return await createLocalQueueRuntimeClient({
      base: options.base,
      cache: options.cache,
      provider: options.provider,
      queue: options.queue,
      rules: options.rules,
    })
  }

  if (options.provider === "postgres") {
    // The generated server installs the postgres client, so an app without it does not bundle the Postgres driver.
    const createClient = getQueueRuntimeClientFactory()
    if (!createClient) throw queueErrorDiagnostics.QUEUE_RUNTIME_NOT_INSTALLED()
    return await createClient(options)
  }

  const { createVercelQueueRuntimeClient } = await import("../internal/runtime/vercel-client.ts")
  return await createVercelQueueRuntimeClient(options)
}
