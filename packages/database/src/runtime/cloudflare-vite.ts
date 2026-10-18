import { createCloudflareHostedWorker } from "@vite-hub/internal/runtime/cloudflare-hosted"
import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import type { VitehubApp } from "@vite-hub/internal/runtime/app"
import type { CloudflareWorkerEnv, CloudflareWorkerExecutionContext } from "@vite-hub/internal/runtime/cloudflare-env"

export interface DatabaseCloudflareWorkerOptions {
  app?: VitehubApp
}

export function createDbCloudflareWorker(options: DatabaseCloudflareWorkerOptions = {}) {
  return createCloudflareHostedWorker({
    app: options.app,
    label: "database",
    async onRequest({ env, executionContext, handle }: { env: CloudflareWorkerEnv, executionContext: CloudflareWorkerExecutionContext, handle: () => Promise<Response> }) {
      return await runWithActiveCloudflareEnv(env, () => handle())
    },
  })
}
