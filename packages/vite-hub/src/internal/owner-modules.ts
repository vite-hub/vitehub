import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { findContentEntry } from "@vite-hub/source/vite"
import { parseAst } from "vite"

import { assertFeaturePackages, importOptionalOwner, type OptionalFeature } from "./optional-owners.ts"

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
  for (const directory of serverDirs ?? ["server"]) {
    for (const extension of [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]) {
      const file = resolve(projectRoot, directory, `${name}${extension}`)
      if (existsSync(file)) return file
    }
  }
}

/** Follow the relative Content re-exports accepted by CMS discovery, without loading an optional owner. */
function importsCmsPreset(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false
  seen.add(file)
  const source = readFileSync(file, "utf8")
  const program = parseAst(source, { lang: /\.[cm]?tsx$/.test(file) ? "tsx" : /\.[cm]?jsx$/.test(file) ? "jsx" : /\.[cm]?ts$/.test(file) ? "ts" : "js" })
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type"
      && ["@vite-hub/cms", "vite-hub/cms"].includes(statement.source.value)) return true
    if (statement.type !== "ExportAllDeclaration" && statement.type !== "ExportNamedDeclaration") continue
    if (!statement.source?.value.startsWith(".")) continue
    if (statement.type === "ExportNamedDeclaration" && !statement.specifiers.some(specifier =>
      specifier.exported.type === "Identifier" ? specifier.exported.name === "content" : specifier.exported.value === "content",
    )) continue
    const base = resolve(dirname(file), statement.source.value)
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]
    const target = [base, ...extensions.map(ext => `${base}${ext}`), ...extensions.map(ext => join(base, `index${ext}`))].find(candidate => existsSync(candidate))
    if (target && importsCmsPreset(target, seen)) return true
  }
  return false
}

/**
 * Comments, Content, and the `cms` preset are on when the app has `server/comments.ts` or `server/content.ts`. This
 * plugin fails the build when such a file exists but its package is not installed.
 */
export function optionalOwnerEntriesPlugin(): Plugin {
  return {
    name: "vite-hub/optional-owner-entries",
    async configResolved(config) {
      // SAFETY: The resolved config keeps ViteHub's shared keys from the config hook.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[] }
      const projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(config.root)
      const serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const content = await findContentEntry({ projectRoot, serverDirs: serverDirs?.slice() })
      const features: OptionalFeature[] = []
      if (findServerEntry(projectRoot, serverDirs, "comments")) features.push("comments", "database")
      if (content) features.push("content")
      if (content && importsCmsPreset(content)) features.push("cms", "database", "workspace")
      assertFeaturePackages([...new Set(features)])
    },
  }
}
