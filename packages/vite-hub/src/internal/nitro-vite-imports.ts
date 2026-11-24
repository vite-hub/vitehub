import { readFile } from "node:fs/promises"

import { importRolldownExperimental } from "@vite-hub/internal/build/rolldown"
import type { Plugin, Rolldown } from "vite"

const rawImport = /[?&]raw(?:[&#]|$)/

/** Loads `?raw` imports as a string default export, as Vite does. */
export function nitroRawImports(): Plugin {
  return {
    name: "vite-hub/nitro-raw-imports",
    load: {
      filter: { id: rawImport },
      async handler(id) {
        const file = id.replace(/[?#].*$/s, "")
        this.addWatchFile(file)
        return { code: `export default ${JSON.stringify(await readFile(file, "utf8"))}`, moduleType: "js" }
      },
    },
  }
}

/**
 * The Vite syntax that server code can use in Nuxt 5, for Nuxt 4.7's separate Rolldown build of Nitro: `import.meta.glob()`
 * and `?raw` imports.
 */
export async function nitroViteImports(root: string): Promise<Rolldown.RolldownPluginOption[]> {
  const { viteImportGlobPlugin } = await importRolldownExperimental(root)
  return [viteImportGlobPlugin({ root }), nitroRawImports()]
}
