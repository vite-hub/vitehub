import { H3, toWebHandler } from "h3"

import { resolveDbAppFetch, type DBApp } from "./_app.ts"

export interface DBCloudflareWorkerOptions {
  app?: DBApp
}

export interface DBCloudflareWorker {
  fetch: (request: Request, env: Record<string, unknown>, context: { waitUntil?: (promise: Promise<unknown>) => void }) => Promise<Response>
}

export function createDbCloudflareWorker(options: DBCloudflareWorkerOptions = {}): DBCloudflareWorker {
  const appHandler = resolveDbAppFetch(options.app)
  const defaultHandler = toWebHandler(new H3())

  return {
    async fetch(request: Request, _env: Record<string, unknown>, context: { waitUntil?: (promise: Promise<unknown>) => void }) {
      return await Promise.resolve(appHandler ? appHandler(request, context as never) : defaultHandler(request, context as never))
    },
  }
}
