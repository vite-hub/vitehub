// Nitro resolves these at build time. The declarations cover what the handlers use.
declare module "#docs/manifest" {
  const manifest: import("../../types.ts").DocsManifest
  export default manifest
}

/** The `content` export of the app's `server/content.ts`, or undefined when the app has none. */
declare module "#docs/content" {
  export const content: import("../../draft.ts").DocsContentRuntime | undefined
}

/** The default export of the module that the `parser` option names, or `{}` without one. */
declare module "#docs/parser" {
  const parser: import("../../markdown.ts").DocsParserOptions
  export default parser
}

/** The source of each Vue file in the examples folder, by name. */
declare module "#docs/example-sources" {
  const examples: Record<string, string>
  export default examples
}

declare module "#imports" {
  import type { H3Event } from "h3"

  export { createError, defineEventHandler, getRequestURL, getRouterParam, setHeader } from "h3"
  export function useStorage(base: string): { getItem<T>(key: string): Promise<T | null> }
  export function useRuntimeConfig(event?: H3Event): { public: Record<string, unknown> }
}
