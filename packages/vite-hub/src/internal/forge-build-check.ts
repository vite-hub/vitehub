import { readFileSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"

import type { Plugin } from "vite"

import { assertFeaturePackages, isPackageInstalled } from "./optional-owners.ts"

const missingForge = "\0vitehub:forge-not-installed"

/**
 * Only the GitHub Source loads Forge from @vite-hub/source. A retained import there indicates a live Source path.
 * Workspaces and Agents also import Forge from shared runtime code, so they check at store and channel selection.
 */
export function forgeBuildCheckPlugin(): Plugin {
  return {
    name: "vite-hub/forge-build-check",
    apply: "build",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "@vite-hub/forge" || !importer || isPackageInstalled(source)) return
      const file = importer.split("?", 1)[0]!
      const url = file.startsWith("file:") ? file : isAbsolute(file) ? pathToFileURL(file) : undefined
      const manifest = url && findPackageJSON(url)
      if (manifest && JSON.parse(readFileSync(manifest, "utf8")).name === "@vite-hub/source") return missingForge
    },
    load(id) {
      if (id === missingForge) return "export {}\n"
    },
    generateBundle(_options, bundle) {
      const loadsForge = Object.values(bundle).some(output => output.type === "chunk" && output.moduleIds.includes(missingForge))
      if (loadsForge) assertFeaturePackages(["forge"])
    },
  }
}
