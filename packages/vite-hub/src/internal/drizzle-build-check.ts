import { readFileSync } from "node:fs"
import { findPackageJSON } from "node:module"
import { isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"

import { isPlainObject } from "@vite-hub/internal/object"
import type { Plugin } from "vite"

import { unsupportedPeerPackagesError } from "./optional-owners.ts"

/** The journal itself does not use Drizzle. Check only when a build reaches a ViteHub codec import. */
export function drizzleBuildCheckPlugin(): Plugin {
  return {
    name: "vite-hub/drizzle-build-check",
    apply: "build",
    enforce: "pre",
    resolveId: {
      order: "pre",
      handler(source, importer) {
        if (source !== "drizzle-orm/libsql/codecs" && source !== "drizzle-orm/d1/codecs") return
        const path = importer?.split("?", 1)[0]
        if (!path || !isAbsolute(path)) return
        const from = pathToFileURL(path)
        let manifest: string | undefined
        try {
          const owner = findPackageJSON(from)
          if (!owner) return
          const ownerPackage: unknown = JSON.parse(readFileSync(owner, "utf8"))
          if (!isPlainObject(ownerPackage)) return
          if (ownerPackage.name !== "@vite-hub/agent" && ownerPackage.name !== "@vite-hub/database") return
          manifest = findPackageJSON("drizzle-orm", from)
        }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") return
          throw error
        }
        if (!manifest) return
        const drizzlePackage: unknown = JSON.parse(readFileSync(manifest, "utf8"))
        if (!isPlainObject(drizzlePackage) || typeof drizzlePackage.version !== "string") return
        const { version } = drizzlePackage
        const error = unsupportedPeerPackagesError(["drizzle-orm"], () => version)
        if (error) throw error
      },
    },
  }
}
