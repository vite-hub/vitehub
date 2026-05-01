import { H3, toWebHandler } from "h3/cloudflare"

import { resolveAppFetch, type VitehubApp } from "./app.ts"
import type { CloudflareWorkerEnv, CloudflareWorkerExecutionContext } from "./cloudflare-env.ts"

type AppHandler = NonNullable<ReturnType<typeof resolveAppFetch>>

export interface CloudflareHostedWorkerAdapter<TEnv extends CloudflareWorkerEnv = CloudflareWorkerEnv> {
  app?: VitehubApp
  label: string
  onRequest?: (context: {
    env: TEnv
    executionContext: CloudflareWorkerExecutionContext | undefined
    handle: (handlerContext?: Record<string, unknown>) => Promise<Response>
  }) => Promise<Response>
}

function createWebRequestHandler(appHandler: AppHandler | undefined): AppHandler {
  const defaultHandler = toWebHandler(new H3())
  return async (request, context) => await Promise.resolve(appHandler ? appHandler(request, context) : defaultHandler(request, context as never))
}

export function createCloudflareHostedWorker<TEnv extends CloudflareWorkerEnv = CloudflareWorkerEnv>(
  adapter: CloudflareHostedWorkerAdapter<TEnv>,
): { fetch: (request: Request, env: TEnv, context: CloudflareWorkerExecutionContext) => Promise<Response> } {
  const requestHandler = createWebRequestHandler(resolveAppFetch(adapter.label, adapter.app))

  return {
    async fetch(request, env, context) {
      const handle = async (handlerContext?: Record<string, unknown>) => await Promise.resolve(requestHandler(request, handlerContext))
      if (adapter.onRequest) {
        return await adapter.onRequest({
          env,
          executionContext: context,
          handle,
        })
      }

      return await handle()
    },
  }
}
