import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { importOptionalOwner, missingFeaturePackagesError, type OptionalFeature } from "./optional-owners.ts"

import type { Plugin } from "vite"

/** The build-time modules of the optional owner packages. A module is `undefined` when the app did not install its package. */
export const ownerModules = {
  agentVite: await importOptionalOwner("@vite-hub/agent", () => import("@vite-hub/agent/vite")),
  authConsole: await importOptionalOwner("@vite-hub/auth", () => import("@vite-hub/auth/console")),
  authVite: await importOptionalOwner("@vite-hub/auth", () => import("@vite-hub/auth/vite")),
  cmsVite: await importOptionalOwner("@vite-hub/cms", () => import("@vite-hub/cms/vite")),
  commentsVite: await importOptionalOwner("@vite-hub/comments", () => import("@vite-hub/comments/vite")),
  contentVite: await importOptionalOwner("@vite-hub/content", () => import("@vite-hub/content/vite")),
  databaseConfig: await importOptionalOwner("@vite-hub/database", () => import("@vite-hub/database/config")),
  databaseVite: await importOptionalOwner("@vite-hub/database", () => import("@vite-hub/database/vite")),
  realtimeVite: await importOptionalOwner("@vite-hub/realtime", () => import("@vite-hub/realtime/vite")),
  scheduleVite: await importOptionalOwner("@vite-hub/schedule", () => import("@vite-hub/schedule/vite")),
  workspaceVite: await importOptionalOwner("@vite-hub/workspace", () => import("@vite-hub/workspace/vite")),
}

function findServerEntry(projectRoot: string, serverDirs: readonly string[] | undefined, name: string): string | undefined {
  for (const directory of serverDirs?.length ? serverDirs : ["server"]) {
    for (const extension of [".ts", ".mts", ".js", ".mjs"]) {
      const file = resolve(projectRoot, directory, `${name}${extension}`)
      if (existsSync(file)) return file
    }
  }
}

/**
 * Comments, Content, and the `cms` preset are on when the app has `server/comments.ts` or `server/content.ts`. This
 * plugin fails the build when such a file exists but its package is not installed.
 */
export function optionalOwnerEntriesPlugin(): Plugin {
  return {
    name: "vite-hub/optional-owner-entries",
    configResolved(config) {
      // SAFETY: The resolved config keeps ViteHub's shared keys from the config hook.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[] }
      const projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(config.root)
      const serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const content = findServerEntry(projectRoot, serverDirs, "content")
      const missing: OptionalFeature[] = []
      if (!ownerModules.commentsVite && findServerEntry(projectRoot, serverDirs, "comments")) missing.push("comments")
      if (content && !ownerModules.contentVite) missing.push("content")
      if (content && !ownerModules.cmsVite && /["'](?:@vite-hub|vite-hub)\/cms["']/.test(readFileSync(content, "utf8"))) missing.push("cms")
      if (missing.length) throw missingFeaturePackagesError(missing)
    },
  }
}
