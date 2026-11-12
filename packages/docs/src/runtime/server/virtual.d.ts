// Nitro resolves these at build time. The declarations cover what the handlers use.
declare module "#docs/manifest" {
  const manifest: import("../../types.ts").DocsManifest
  export default manifest
}

/** The `content` export of the app's `server/content.ts`, or undefined when the app has none. */
declare module "#docs/content" {
  export const content: import("../../draft.ts").DocsContentRuntime | undefined
}

/** The default export of the module that the `parser` option names, or `{}` without one, and `docs.github.repo`. */
declare module "#docs/parser" {
  const parser: import("../../markdown.ts").DocsParserOptions
  export default parser
  export const githubRepo: string | null
}

/** The source of each Vue file in the examples folder, by name. */
declare module "#docs/example-sources" {
  const examples: Record<string, string>
  export default examples
}

/** The `llms` option of the docs module. */
declare module "#docs/agent" {
  const agent: { llms: import("../../nuxt.ts").DocsLlmsOptions }
  export default agent
}
