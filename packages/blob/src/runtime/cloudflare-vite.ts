import { H3, toWebHandler } from "h3"

import { resolveBlobAppFetch, type BlobApp } from "./_app.ts"
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
  const appHandler = resolveBlobAppFetch(options.app)
  const defaultHandler = toWebHandler(new H3())

  return {
    async fetch(request, env, context) {
      setBlobRuntimeConfig(options.blob)
      return await runWithActiveCloudflareEnv(env, async () => {
        try {
          return await Promise.resolve(appHandler ? appHandler(request, context as never) : defaultHandler(request, context as never))
        }
        finally {
          clearActiveCloudflareEnv()
        }
      })
    },
  }
}
