import { consoleDocumentEditorSectionIds } from "./contributions.ts"

import type { Plugin } from "vite"

/** Every module that the operation transform changes reads one of these `import.meta.viteHubConsole*` flags. */
export const consoleOperationFeaturesFilter = { code: "import.meta.viteHubConsole" }

/**
 * Remove disabled operation loaders before server bundlers follow their optional imports. The document editor and media
 * library code stays only when the app configures a document editor section that an owner package, such as
 * `@vite-hub/content`, contributes.
 */
export function transformConsoleOperationFeatures(code: string, sections: readonly string[], documents?: boolean): string | undefined {
  const transformed = code
    .replaceAll("import.meta.viteHubConsoleAgents", String(sections.includes("agents")))
    .replaceAll("import.meta.viteHubConsoleAuth", String(sections.includes("auth")))
    .replaceAll("import.meta.viteHubConsoleDocuments", String(documents ?? consoleDocumentEditorSectionIds.some(section => sections.includes(section))))
  return transformed === code ? undefined : transformed
}

/**
 * Nuxt's Nitro bundles the Console independently of the app's Vite plugins. `documents` reads the document editors of the
 * written Console app module, because discovery finds them after the plugin is installed.
 */
export function consoleOperationFeatures(sections: readonly string[], documents: () => boolean | undefined = () => undefined): Plugin {
  return {
    name: "vite-hub/console-operation-features",
    transform: {
      filter: consoleOperationFeaturesFilter,
      handler(code) {
        const transformed = transformConsoleOperationFeatures(code, sections, documents())
        return transformed === undefined ? undefined : { code: transformed, map: null }
      },
    },
  }
}
