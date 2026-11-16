import { consoleDocumentEditorSectionIds } from "./contributions.ts"

import type { Plugin } from "vite"

/** Every module that the operation transform changes reads one of these `import.meta.viteHubConsole*` flags. */
export const consoleOperationFeaturesFilter = { code: "import.meta.viteHubConsole" }

/**
 * Remove disabled operation loaders before server bundlers follow their optional imports. The document editor and media
 * library code stays only when an installed owner package, such as `@vite-hub/content`, contributes a document editor.
 */
export function transformConsoleOperationFeatures(code: string, sections: readonly string[], documents = consoleDocumentEditorSectionIds.length > 0): string | undefined {
  const transformed = code
    .replaceAll("import.meta.viteHubConsoleOperationSections", JSON.stringify(sections))
    .replaceAll("import.meta.viteHubConsoleAgents", String(sections.includes("agents")))
    .replaceAll("import.meta.viteHubConsoleAuth", String(sections.includes("auth")))
    .replaceAll("import.meta.viteHubConsoleDatabase", String(sections.includes("databases")))
    .replaceAll("import.meta.viteHubConsoleWorkspaces", String(sections.includes("workspaces")))
    .replaceAll("import.meta.viteHubConsoleDocuments", String(documents))
  return transformed === code ? undefined : transformed
}

/** Nuxt's Nitro bundles the Console independently of the app's Vite plugins. */
export function consoleOperationFeatures(sections: readonly string[]): Plugin {
  return {
    name: "vite-hub/console-operation-features",
    transform: {
      filter: consoleOperationFeaturesFilter,
      handler(code) {
        const transformed = transformConsoleOperationFeatures(code, sections)
        return transformed === undefined ? undefined : { code: transformed, map: null }
      },
    },
  }
}
