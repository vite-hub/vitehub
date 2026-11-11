import type { QueueClient, QueueProviderOptions } from "../types.ts"

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
    // Node bundlers retain the provider; Worker conditions select a module without its optional driver.
    const { createPostgresQueueRuntimeClient } = await import("#vitehub/queue/node-client")
    return await createPostgresQueueRuntimeClient(options)
  }

  const { createVercelQueueRuntimeClient } = await import("../internal/runtime/vercel-client.ts")
  return await createVercelQueueRuntimeClient(options)
}
