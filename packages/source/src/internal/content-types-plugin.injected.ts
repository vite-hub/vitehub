/**
 * Source of the generated Nitro plugin that writes the types of `content.get()`, `content.list()`, and
 * `content.query()` in development. `importBase` and `contentModule` are JSON string literals of import paths. The
 * text runs in the app server, not here, so its error stays plain.
 */
export function renderContentTypesPlugin(importBase: string, contentModule: string): string {
  return [
    `import { defineContentTypesPlugin } from ${importBase}`,
    'import { useRuntimeConfig } from "nitro/runtime-config"',
    "",
    "// A production build drops this branch, so the server does not load Content at startup.",
    "const write = async (declarations) => {",
    '  const response = await fetch(useRuntimeConfig().vitehubContentTypesWriter, { method: "POST", body: declarations })',
    '  if (!response.ok) throw new Error(`Content types writer returned ${response.status}`)',
    "}",
    `export default import.meta.dev ? defineContentTypesPlugin(async () => (await import(${contentModule})).default, write, { moduleName: ${importBase} }) : () => {}`,
    "",
  ].join("\n")
}
