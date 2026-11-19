import type { Plugin } from "vite"

import { assertFeaturePackages, isPackageInstalled } from "./optional-owners.ts"

const missingForge = "\0vitehub:forge-not-installed"

/**
 * A github() Source, a GitHub Workspace, and the Forge Channels load the optional `@vite-hub/forge` on their first
 * request. Without it, the bundler keeps the import for run time, so the build passes and the first request fails with
 * `INTERNAL_FORGE_NOT_INSTALLED`. This plugin gives the missing package an empty module, and fails the build with the
 * install command when that module is still in the output, which means that server code can load it. When tree shaking
 * removes the import, for example because the app does not call github(), the build passes.
 */
export function forgeBuildCheckPlugin(): Plugin {
  return {
    name: "vite-hub/forge-build-check",
    apply: "build",
    enforce: "pre",
    resolveId(source) {
      if (source === "@vite-hub/forge" && !isPackageInstalled("@vite-hub/forge")) return missingForge
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
