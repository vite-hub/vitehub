import { createVercelHostedServer } from "@vite-hub/internal/runtime/vercel-hosted"

import type { VitehubApp } from "@vite-hub/internal/runtime/app"
import { setBlobRuntimeConfig } from "./state.ts"

import type { ResolvedBlobModuleOptions } from "../types.ts"

export interface BlobVercelServerOptions {
  app?: VitehubApp
  blob?: false | ResolvedBlobModuleOptions
}

export type BlobVercelServer = (req: unknown, res: unknown) => unknown

export function createBlobVercelServer(options: BlobVercelServerOptions = {}): BlobVercelServer {
  return createVercelHostedServer({
    app: options.app,
    label: "blob",
    onRequest({ handle }) {
      setBlobRuntimeConfig(options.blob)
      return handle()
    },
  })
}
