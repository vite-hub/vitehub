import type { QueueClient, QueueDriverOptions } from "../types.ts"

export async function createQueueClient(options: QueueDriverOptions): Promise<QueueClient> {
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
    // Node bundlers retain the driver; Worker conditions select a module without its optional driver.
    const { createPostgresQueueRuntimeClient } = await import("#vitehub/queue/node-client")
    return await createPostgresQueueRuntimeClient(options)
  }

  const { createVercelQueueRuntimeClient } = await import("../internal/runtime/vercel-client.ts")
  return await createVercelQueueRuntimeClient(options)
}
