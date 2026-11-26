import { consoleDocumentEditorSectionIds } from "./contributions.ts"

import type { Plugin } from "vite"

/** Every module that the operation transform changes reads one of these `import.meta.viteHubConsole*` flags. */
export const consoleOperationFeaturesFilter = { code: "import.meta.viteHubConsole" }

/**
 * Remove disabled operation loaders before server bundlers follow their optional imports. The document editor and media
 * library code stays only when the app configures a document editor section that an owner package, such as
 * `@vite-hub/content`, contributes. With `development: false`, the development-only loopback peer check is removed.
 */
export function transformConsoleOperationFeatures(code: string, sections: readonly string[], documents?: boolean, development?: boolean): string | undefined {
  const featured = code
    .replaceAll("import.meta.viteHubConsoleAgents", String(sections.includes("agents")))
    .replaceAll("import.meta.viteHubConsoleAuth", String(sections.includes("auth")))
    .replaceAll("import.meta.viteHubConsoleDocuments", String(documents ?? consoleDocumentEditorSectionIds.some(section => sections.includes(section))))
  const transformed = development === undefined ? featured : featured.replaceAll("import.meta.viteHubConsoleDevelopment", String(development))
  return transformed === code ? undefined : transformed
}

/**
 * Nuxt's Nitro bundles the Console independently of the app's Vite plugins. `documents` reads the document editors of the
 * written Console app module, because discovery finds them after the plugin is installed. A development server keeps the
 * document code whenever an owner contributes an editor, because it caches the transform and an editor can appear later.
 */
export function consoleOperationFeatures(sections: readonly string[], documents: () => boolean | undefined = () => undefined, development?: boolean): Plugin {
  return {
    name: "vite-hub/console-operation-features",
    transform: {
      filter: consoleOperationFeaturesFilter,
      handler(code) {
        const transformed = transformConsoleOperationFeatures(code, sections, documents(), development)
        return transformed === undefined ? undefined : { code: transformed, map: null }
      },
    },
  }
}
