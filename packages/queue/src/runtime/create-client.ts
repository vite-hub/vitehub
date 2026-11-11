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
    // Resolve this Node-only runtime at execution time. A literal import pulls its optional driver into Worker builds.
    const runtimeUrl = new URL(
      import.meta.url.endsWith(".ts") ? "./src/internal/runtime/postgres-client.ts" : "./dist/internal/runtime/postgres-client.js",
      import.meta.resolve("@vite-hub/queue/package.json"),
    )
    const { createPostgresQueueRuntimeClient }: typeof import("../internal/runtime/postgres-client.ts") = await import(/* @vite-ignore */ runtimeUrl.href)
    return await createPostgresQueueRuntimeClient(options)
  }

  const { createVercelQueueRuntimeClient } = await import("../internal/runtime/vercel-client.ts")
  return await createVercelQueueRuntimeClient(options)
}
