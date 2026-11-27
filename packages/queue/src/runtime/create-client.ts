import { queueErrorDiagnostics } from "../error-diagnostics.ts"

import type { QueueClient, QueueDriverOptions } from "../types.ts"

export async function createQueueClient(options: QueueDriverOptions): Promise<QueueClient> {
  if (options.driver === undefined && Object.hasOwn(options, "provider")) {
    // SAFETY: A caller without types still passes the former `provider` key.
    const provider = (options as { provider?: unknown }).provider
    throw queueErrorDiagnostics.QUEUE_RENAMED_PROVIDER_KEY({ value: JSON.stringify(provider) ?? String(provider) })
  }
  if (options.driver === "cloudflare") {
    const { createCloudflareQueueRuntimeClient } = await import("../internal/runtime/cloudflare-client.ts")
    return await createCloudflareQueueRuntimeClient(options)
  }

  if (options.driver === "local") {
    const { createLocalQueueRuntimeClient } = await import("../internal/runtime/local-client.ts")
    return await createLocalQueueRuntimeClient({
      base: options.base,
      cache: options.cache,
      driver: options.driver,
      queue: options.queue,
      rules: options.rules,
    })
  }

  if (options.driver === "postgres") {
    const { createPostgresQueueRuntimeClient } = await import("#vitehub/queue/node-client")
    return await createPostgresQueueRuntimeClient(options)
  }

  const { createVercelQueueRuntimeClient } = await import("../internal/runtime/vercel-client.ts")
  return await createVercelQueueRuntimeClient(options)
}
