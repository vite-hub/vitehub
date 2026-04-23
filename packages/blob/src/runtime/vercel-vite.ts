import { H3, fromWebHandler } from "h3"
import { toNodeHandler } from "h3/node"

import { resolveBlobAppFetch, type BlobApp } from "./_app.ts"
import { setBlobRuntimeConfig } from "./state.ts"

import type { ResolvedBlobModuleOptions } from "../types.ts"

export interface BlobVercelServerOptions {
  app?: BlobApp
  blob?: false | ResolvedBlobModuleOptions
}

export type BlobVercelServer = (req: unknown, res: unknown) => unknown

export function createBlobVercelServer(options: BlobVercelServerOptions = {}): BlobVercelServer {
  setBlobRuntimeConfig(options.blob)

  const app = new H3()
  const fetchHandler = resolveBlobAppFetch(options.app)
  if (fetchHandler) {
    app.use(fromWebHandler(async (request, context) => await fetchHandler(request as never, context as never)))
  }

  const nodeHandler = toNodeHandler(app)
  return function vercelBlobServer(req, res) {
    return nodeHandler(req as never, res as never)
  }
}
