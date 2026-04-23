import { H3, toWebHandler } from "h3"

import { resolveBlobAppFetch, type BlobApp } from "./_app.ts"
import { getActiveCloudflareEnv, setActiveCloudflareEnv, setBlobRuntimeConfig } from "./state.ts"

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
      let requestSettled = false
      const pendingWaitUntil = new Set<Promise<unknown>>()
      const maybeClearActiveEnv = () => {
        if (requestSettled && pendingWaitUntil.size === 0 && getActiveCloudflareEnv() === env) {
          setActiveCloudflareEnv(undefined)
        }
      }

      const runtimeContext = typeof context.waitUntil === "function"
        ? {
            ...context,
            waitUntil(promise: Promise<unknown>) {
              const wrappedPromise = Promise.resolve(promise).finally(() => {
                pendingWaitUntil.delete(wrappedPromise)
                maybeClearActiveEnv()
              })
              pendingWaitUntil.add(wrappedPromise)
              context.waitUntil?.(wrappedPromise)
            },
          }
        : context

      setBlobRuntimeConfig(options.blob)
      setActiveCloudflareEnv(env)
      try {
        return await Promise.resolve(appHandler ? appHandler(request, runtimeContext as never) : defaultHandler(request, runtimeContext as never))
      }
      finally {
        requestSettled = true
        maybeClearActiveEnv()
      }
    },
  }
}
