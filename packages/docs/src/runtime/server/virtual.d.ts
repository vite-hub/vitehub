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

/** The docs Markdown files packed into one module in a production build, or null in development. */
declare module "#docs/files" {
  const files: import("../../files.ts").DocsPackedFiles | null
  export default files
}
