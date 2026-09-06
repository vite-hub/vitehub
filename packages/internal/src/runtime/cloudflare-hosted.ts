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
  return async (request, context) => await Promise.resolve(
    appHandler
      ? appHandler(request, context)
      : new Response(JSON.stringify({ status: 404, message: `Cannot find any route matching [${request.method}] ${request.url}` }), {
          headers: { "content-type": "application/json;charset=UTF-8" },
          status: 404,
          statusText: "Not Found",
        }),
  )
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
