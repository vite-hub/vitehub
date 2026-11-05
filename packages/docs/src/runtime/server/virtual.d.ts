// Nitro resolves these at build time. The declarations cover what the handlers use.
declare module "#docs/manifest" {
  import type { DocsManifest } from "../../types.ts"

  const manifest: DocsManifest
  export default manifest
}

/** The `content` export of the app's `server/content.ts`, or undefined when the app has none. */
declare module "#docs/content" {
  import type { DocsContentRuntime } from "../../draft.ts"

  export const content: DocsContentRuntime | undefined
}

/** The default export of the module that the `parser` option names, or `{}` without one. */
declare module "#docs/parser" {
  import type { DocsParserOptions } from "../../markdown.ts"

  const parser: DocsParserOptions
  export default parser
}

declare module "#imports" {
  import type { H3Event } from "h3"

  export { createError, defineEventHandler, getRequestURL, getRouterParam, setHeader } from "h3"
  export function useStorage(base: string): { getItem<T>(key: string): Promise<T | null> }
  export function useRuntimeConfig(event?: H3Event): { public: Record<string, unknown> }
}
