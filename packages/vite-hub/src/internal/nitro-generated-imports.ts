import { dirname, resolve, sep } from "node:path"

import type { Plugin } from "vite"

/**
 * Generated `.vitehub` modules import package files by relative path, such as the Blob runtime importing
 * `../../../packages/blob/dist/runtime/state.js`. Nitro 2 development keeps files outside the app external. When
 * `@rollup/plugin-node-resolve` learns that, it returns `false` for the relative import, and Rollup writes the relative
 * path into the bundle from the wrong folder, so Node cannot load it. Resolve the import to its absolute file first, so
 * Nitro externalizes that file by its absolute URL.
 */
export function nitroGeneratedRelativeImports(generatedRoots: readonly string[]): Plugin {
  const roots = generatedRoots.map(root => `${resolve(root)}${sep}`)
  return {
    name: "vite-hub/nitro-generated-relative-imports",
    async resolveId(source, importer, options) {
      if (!importer || !/^\.\.?\//.test(source)) return
      const file = importer.split("?", 1)[0]!
      if (!roots.some(root => file.startsWith(root))) return
      return await this.resolve(resolve(dirname(file), source), importer, { ...options, skipSelf: true })
    },
  }
}
