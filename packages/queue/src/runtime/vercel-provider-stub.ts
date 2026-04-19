import { QueueError } from "../errors.ts"
import type { VercelQueueClient, VercelQueueProviderOptions } from "../types.ts"

export async function createVercelQueueClient(_provider: VercelQueueProviderOptions): Promise<VercelQueueClient> {
  throw new QueueError("The Vercel queue provider is not available in this build.", {
    code: "VERCEL_QUEUE_PROVIDER_UNAVAILABLE",
    provider: "vercel",
  })
}
