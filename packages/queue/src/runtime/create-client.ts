import type { QueueClient, QueueProviderOptions } from "../types.ts"

export async function createQueueClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider === "cloudflare") {
    const { createCloudflareQueueRuntimeClient } = await import("../internal/runtime/cloudflare-client.ts")
    return await createCloudflareQueueRuntimeClient(options)
  }

  if (options.provider === "local") {
    const { createLocalQueueRuntimeClient } = await import("../internal/runtime/local-client.ts")
    return await createLocalQueueRuntimeClient(options)
  }

  const { createVercelQueueRuntimeClient } = await import("../internal/runtime/vercel-client.ts")
  return await createVercelQueueRuntimeClient(options)
}
