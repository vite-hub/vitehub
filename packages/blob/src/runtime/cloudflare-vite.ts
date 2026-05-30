import { createCloudflareHostedWorker } from "@vite-hub/internal/runtime/cloudflare-hosted"

import type { BlobApp } from "./_app.ts"
import { clearActiveCloudflareEnv, runWithActiveCloudflareEnv, setBlobRuntimeConfig } from "./state.ts"

import type { ResolvedBlobModuleOptions } from "../types.ts"

export interface BlobCloudflareWorkerOptions {
  app?: BlobApp
  blob?: false | ResolvedBlobModuleOptions
}

export interface BlobCloudflareWorker {
  fetch: (request: Request, env: Record<string, unknown>, context: { waitUntil?: (promise: Promise<unknown>) => void }) => Promise<Response>
}

export function createBlobCloudflareWorker(options: BlobCloudflareWorkerOptions = {}): BlobCloudflareWorker {
  return createCloudflareHostedWorker({
    app: options.app,
    label: "blob",
    async onRequest({ env, executionContext, handle }) {
      return await runWithActiveCloudflareEnv(env, async () => {
        try {
          setBlobRuntimeConfig(options.blob)
          return await handle(executionContext as never)
        }
        finally {
          clearActiveCloudflareEnv()
        }
      })
    },
  })
}
