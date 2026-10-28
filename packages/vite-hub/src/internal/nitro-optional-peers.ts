import { readFileSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"

import * as v from "valibot"
import type { Plugin } from "vite"

const manifestSchema = v.object({
  optionalDependencies: v.optional(v.record(v.string(), v.string())),
  peerDependenciesMeta: v.optional(v.record(v.string(), v.object({ optional: v.optional(v.boolean()) }))),
})

/** Honor each importing package's optional dependencies before Nitro rejects unresolved Worker imports. */
export function nitroOptionalPeers(config: { alias?: unknown } = {}): Plugin {
  const manifests = new Map<string, Set<string>>()
  return {
    name: "vite-hub/nitro-optional-peers",
    async resolveId(source, importer, options) {
      if (!importer || (!isAbsolute(importer) && !importer.startsWith("file://")) || /^[./#\0]|:/.test(source)) return
      if (config.alias && Object.keys(config.alias).some(alias => source === alias || source.startsWith(`${alias}/`))) return
      const packageName = source.startsWith("@") ? source.split("/").slice(0, 2).join("/") : source.split("/")[0]!
      const parent = importer.startsWith("file://") ? importer : pathToFileURL(importer).href
      let owner: string | undefined
      try { owner = findPackageJSON(parent) }
      catch { return }
      if (!owner || !/[\\/]package\.json$/.test(owner)) return
      let optional = manifests.get(owner)
      if (!optional) {
        const input: unknown = JSON.parse(readFileSync(owner, "utf8"))
        const manifest = v.parse(manifestSchema, input)
        optional = new Set([
          ...Object.keys(manifest.optionalDependencies ?? {}),
          ...Object.entries(manifest.peerDependenciesMeta ?? {}).filter(([, metadata]) => metadata.optional).map(([name]) => name),
        ])
        manifests.set(owner, optional)
      }
      if (!optional.has(packageName)) return
      try {
        findPackageJSON(`${packageName}/package.json`, parent)
      }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND")) return
        // Node's default lookup ignores registered resolvers such as Yarn PnP.
        try {
          return await this.resolve(source, importer, { ...options, skipSelf: true }) ?? { id: source, external: true }
        }
        catch (resolveError) {
          // Nitro 2's Worker resolver throws instead of returning null for unresolved imports.
          if (resolveError instanceof Error && resolveError.message === `Cannot resolve ${JSON.stringify(source)} from ${JSON.stringify(importer)} and externals are not allowed!`) {
            return { id: source, external: true }
          }
          throw resolveError
        }
      }
    },
  }
}
