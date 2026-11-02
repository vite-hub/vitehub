// Nitro resolves these at build time. The declarations cover what the handlers use.
declare module "#docs/manifest" {
  import type { DocsManifest } from "../../types.ts"

  const manifest: DocsManifest
  export default manifest
}

declare module "#imports" {
  import type { H3Event } from "h3"

  export { createError, defineEventHandler, getRequestURL, getRouterParam, setHeader } from "h3"
  export function useStorage(base: string): { getItem<T>(key: string): Promise<T | null> }
  export function useRuntimeConfig(event?: H3Event): { public: Record<string, unknown> }
}
