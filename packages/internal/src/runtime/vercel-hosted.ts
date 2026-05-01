import { H3 } from "h3"

import { resolveAppFetch, type VitehubApp } from "./app.ts"

export interface VercelHostedServerAdapter {
  app?: VitehubApp
  label: string
  onRequest?: (context: {
    handle: () => unknown
    req: unknown
    res: unknown
  }) => unknown
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
