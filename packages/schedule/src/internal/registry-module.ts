/**
 * Renders the `#vitehub/schedule/registry` virtual module. A virtual module has no directory, so a relative import would
 * resolve against the Vite root, which is the app directory under Nuxt. Each definition is imported by its absolute
 * path with forward slashes: Vite and the bundler resolve `C:/repo/...`, but Node rejects `C:\repo\...` as a URL scheme.
 */
export function renderScheduleRegistryModule(definitions: ReadonlyArray<{ handler: string, name: string }>): string {
  return [
    "",
    "const registry = {",
    ...definitions.map(definition => `  [${JSON.stringify(definition.name)}]: async () => import(${JSON.stringify(definition.handler.replace(/\\/g, "/"))}),`),
    "}",
    "",
    "export default registry",
    "",
  ].join("\n")
}
