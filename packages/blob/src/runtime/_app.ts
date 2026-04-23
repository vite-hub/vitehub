import { resolveAppFetch, type VitehubApp } from "@vitehub/internal/runtime/app"

export type BlobApp = VitehubApp

export function resolveBlobAppFetch(app: BlobApp | undefined): ((request: Request, context?: Record<string, unknown>) => Response | Promise<Response>) | undefined {
  return resolveAppFetch("blob", app)
}
