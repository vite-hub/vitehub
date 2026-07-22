import type { QueueClient, QueueProviderOptions } from "../types.ts"

export async function createQueueClient(options: QueueProviderOptions): Promise<QueueClient> {
  if (options.provider === "cloudflare") {
    const { createCloudflareQueueRuntimeClient } = await import("../internal/runtime/cloudflare-client.ts")
    return await createCloudflareQueueRuntimeClient(options)
  }

  const { createVercelQueueRuntimeClient } = await import("../internal/runtime/vercel-client.ts")
  return await createVercelQueueRuntimeClient(options)
}
