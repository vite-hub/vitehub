import { resolveAppFetch } from "@vitehub/internal/runtime/app"
import { H3, fromWebHandler } from "h3"
import { toNodeHandler } from "h3/node"

import type { DBApp } from "./cloudflare-vite.ts"

export type { DBApp }

interface DBVercelServerOptions {
  app?: DBApp
}

export type DBVercelServer = (req: unknown, res: unknown) => unknown

export function createDbVercelServer(options: DBVercelServerOptions = {}): DBVercelServer {
  const app = new H3()
  const fetchHandler = resolveAppFetch("db", options.app)
  if (fetchHandler) {
    app.use(fromWebHandler(async (request, context) => await fetchHandler(request as never, context as never)))
  }

  const nodeHandler = toNodeHandler(app)
  return function vercelDbServer(req, res) {
    return nodeHandler(req as never, res as never)
  }
}
