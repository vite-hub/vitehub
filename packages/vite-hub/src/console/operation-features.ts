import type { Plugin } from "vite"

/** Remove disabled operation loaders before server bundlers follow their optional imports. */
export function transformConsoleOperationFeatures(code: string, sections: readonly string[]): string | undefined {
  const transformed = code
    .replaceAll("import.meta.viteHubConsoleAgents", String(sections.includes("agents")))
    .replaceAll("import.meta.viteHubConsoleDatabase", String(sections.includes("databases")))
  return transformed === code ? undefined : transformed
}

/** Nitro 2 bundles the Console independently of the app's Vite plugins. */
export function consoleOperationFeatures(sections: readonly string[]): Plugin {
  return {
    name: "vite-hub/console-operation-features",
    transform(code) {
      const transformed = transformConsoleOperationFeatures(code, sections)
      return transformed === undefined ? undefined : { code: transformed, map: null }
    },
  }
}
