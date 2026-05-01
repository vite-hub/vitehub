import { H3, toWebHandler } from "h3"

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

export interface VercelHostedServerAdapter {
  app?: VitehubApp
  label: string
  onRequest?: (context: {
    handle: () => unknown
    req: unknown
    res: unknown
  }) => unknown
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

export function createVercelHostedServer(
  adapter: VercelHostedServerAdapter,
): (req: unknown, res: unknown) => unknown {
  const app = new H3()
  const appHandler = resolveAppFetch(adapter.label, adapter.app)

  let nodeHandlerPromise: Promise<(req: unknown, res: unknown) => unknown> | undefined
  return function hostedVercelServer(req, res) {
    const handle = async () => {
      nodeHandlerPromise ||= (async () => {
        if (appHandler) {
          const h3ModulePath = "h3"
          const { fromWebHandler } = await import(h3ModulePath)
          app.use(fromWebHandler(async (request: Request, context?: Record<string, unknown>) => await appHandler(request as never, context as never)))
        }

        const nodeModulePath = "h3/node"
        const { toNodeHandler } = await import(nodeModulePath)
        return toNodeHandler(app)
      })()
      const nodeHandler = await nodeHandlerPromise
      return nodeHandler(req as never, res as never)
    }
    if (adapter.onRequest) {
      return adapter.onRequest({ handle, req, res })
    }

    return handle()
  }
}
