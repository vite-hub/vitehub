import { readFileSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { basename, dirname, isAbsolute } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import type { Plugin } from "vite"

import { assertFeaturePackages, isPackageInstalled } from "./optional-owners.ts"

const sourceEntries = new Set(["vite-hub/source", "@vite-hub/source", "vite-hub/workspace", "@vite-hub/workspace"])
const resolvedSourceEntry = /[/\\](?:(?:dist[/\\](source|workspace|index)\.js)|(?:src[/\\](source|workspace|index)\.ts))$/
const runtimeOwners = new Set(["@vite-hub/workspace", "@vite-hub/agent", "@vite-hub/source", "vite-hub"])
const checkedGitHub = "\0vitehub:checked-github:"
const sourceFacade = "\0vitehub:source-facade:"
const originalEntry = "\0vitehub:original-source-entry:"

/**
 * Check the GitHub helper selected by server code, not the imports kept by shared runtime code.
 */
export function forgeBuildCheckPlugin(): Plugin {
  const owners = new Map<string, string | undefined>()
  const entries = new Map<string, { id: string, external?: boolean | "absolute" | "relative" }>()
  function ownerOf(path: string): string | undefined {
    const directory = dirname(path)
    if (!owners.has(directory)) {
      const manifest = findPackageJSON(pathToFileURL(path))
      owners.set(directory, manifest && basename(manifest) === "package.json" ? JSON.parse(readFileSync(manifest, "utf8")).name : undefined)
    }
    return owners.get(directory)
  }

  return {
    name: "vite-hub/forge-build-check",
    apply: "build",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source.startsWith(originalEntry)) return entries.get(source)
      if (source.startsWith(checkedGitHub)) return source
      if (!importer || isPackageInstalled("@vite-hub/forge")) return
      if (!sourceEntries.has(source)) {
        const matched = isAbsolute(source) && resolvedSourceEntry.exec(source)
        if (!matched) return
        const exportName = matched[1] ?? matched[2]
        const owner = ownerOf(source)
        if (exportName === "index" ? owner !== "@vite-hub/source" && owner !== "@vite-hub/workspace" : owner !== "vite-hub") return
      }
      const file = importer.split("?", 1)[0]!
      const path = file.startsWith("file:") ? fileURLToPath(file) : file
      if (!isAbsolute(path) || runtimeOwners.has(ownerOf(path) ?? "")) return
      const entry = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!entry) return
      const key = JSON.stringify([entry.id, entry.external])
      entries.set(originalEntry + key, { id: entry.id, external: entry.external })
      return { id: sourceFacade + key, moduleSideEffects: false }
    },
    load(id) {
      if (id.startsWith(sourceFacade)) {
        const key = id.slice(sourceFacade.length)
        return `export * from ${JSON.stringify(originalEntry + key)}; export { github } from ${JSON.stringify(checkedGitHub + key)};`
      }
      if (id.startsWith(checkedGitHub)) {
        const key = id.slice(checkedGitHub.length)
        return `import { github as createGitHub } from ${JSON.stringify(originalEntry + key)}; export function github(...args) { return createGitHub(...args); }`
      }
    },
    generateBundle(_options, bundle) {
      const loadsForge = Object.values(bundle).some(output => output.type === "chunk" && output.moduleIds.some(id => id.startsWith(checkedGitHub)))
      if (loadsForge) assertFeaturePackages(["forge"])
    },
  }
}
