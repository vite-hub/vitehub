import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { findContentEntry } from "@vite-hub/source/vite"
import { parseAst } from "vite"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"
import { assertFeaturePackages, importOptionalOwner, type OptionalFeature } from "./optional-owners.ts"

import type { Plugin } from "vite"

/**
 * The build-time modules of the optional owner packages. A module is `undefined` when the app did not install its
 * package, so an app without features loads none of them. They load in parallel.
 */
const [
  agentVite,
  authConsole,
  authVite,
  blobVite,
  browserVite,
  channelsVite,
  cmsVite,
  commentsVite,
  connectionsVite,
  contentVite,
  databaseConfig,
  databaseVite,
  emailVite,
  formsVite,
  i18nNuxt,
  i18nVite,
  kvVite,
  markdownTemplateVite,
  mcpVite,
  queueVite,
  rateLimitVite,
  realtimeVite,
  sandboxTaskVite,
  scheduleVite,
  workflowVite,
  workspaceVite,
] = await Promise.all([
  importOptionalOwner("@vite-hub/agent", () => import("@vite-hub/agent/vite")),
  importOptionalOwner("@vite-hub/auth", () => import("@vite-hub/auth/console")),
  importOptionalOwner("@vite-hub/auth", () => import("@vite-hub/auth/vite")),
  importOptionalOwner("@vite-hub/blob", () => import("@vite-hub/blob/vite")),
  importOptionalOwner("@vite-hub/browser", () => import("@vite-hub/browser/vite")),
  importOptionalOwner("@vite-hub/channels", () => import("@vite-hub/channels/vite")),
  importOptionalOwner("@vite-hub/cms", () => import("@vite-hub/cms/vite")),
  importOptionalOwner("@vite-hub/comments", () => import("@vite-hub/comments/vite")),
  importOptionalOwner("@vite-hub/connections", () => import("@vite-hub/connections/vite")),
  importOptionalOwner("@vite-hub/content", () => import("@vite-hub/content/vite")),
  importOptionalOwner("@vite-hub/database", () => import("@vite-hub/database/config")),
  importOptionalOwner("@vite-hub/database", () => import("@vite-hub/database/vite")),
  importOptionalOwner("@vite-hub/email", () => import("@vite-hub/email/vite")),
  importOptionalOwner("@vite-hub/forms", () => import("@vite-hub/forms/vite")),
  importOptionalOwner("@vite-hub/i18n", () => import("@vite-hub/i18n/nuxt")),
  importOptionalOwner("@vite-hub/i18n", () => import("@vite-hub/i18n/vite")),
  importOptionalOwner("@vite-hub/kv", () => import("@vite-hub/kv/vite")),
  importOptionalOwner("@vite-hub/markdown-template", () => import("@vite-hub/markdown-template/vite")),
  importOptionalOwner("@vite-hub/mcp", () => import("@vite-hub/mcp/vite")),
  importOptionalOwner("@vite-hub/queue", () => import("@vite-hub/queue/vite")),
  importOptionalOwner("@vite-hub/rate-limit", () => import("@vite-hub/rate-limit/vite")),
  importOptionalOwner("@vite-hub/realtime", () => import("@vite-hub/realtime/vite")),
  importOptionalOwner("@vite-hub/sandbox", () => import("@vite-hub/sandbox/task/vite")),
  importOptionalOwner("@vite-hub/schedule", () => import("@vite-hub/schedule/vite")),
  importOptionalOwner("@vite-hub/workflow", () => import("@vite-hub/workflow/vite")),
  importOptionalOwner("@vite-hub/workspace", () => import("@vite-hub/workspace/vite")),
])

export const ownerModules = {
  agentVite,
  authConsole,
  authVite,
  blobVite,
  browserVite,
  channelsVite,
  cmsVite,
  commentsVite,
  connectionsVite,
  contentVite,
  databaseConfig,
  databaseVite,
  emailVite,
  formsVite,
  i18nNuxt,
  i18nVite,
  kvVite,
  markdownTemplateVite,
  mcpVite,
  queueVite,
  rateLimitVite,
  realtimeVite,
  sandboxTaskVite,
  scheduleVite,
  workflowVite,
  workspaceVite,
}

function findServerEntry(projectRoot: string, serverDirs: readonly string[] | undefined, name: string): string | undefined {
  for (const directory of serverDirs ?? ["server"]) {
    for (const extension of [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]) {
      const file = resolve(projectRoot, directory, `${name}${extension}`)
      if (existsSync(file)) return file
    }
  }
}

/** Whether the app has a `server/forms/` folder. Forms then needs its package. */
export function hasFormsDirectory(projectRoot: string, serverDirs: readonly string[] | undefined): boolean {
  return (serverDirs ?? ["server"]).some(directory => existsSync(resolve(projectRoot, directory, "forms")))
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
      specifier.exported.type === "Identifier" ? specifier.exported.name === "default" : specifier.exported.value === "default",
    )) continue
    const base = resolve(dirname(file), statement.source.value)
    const extensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]
    const target = [base, ...extensions.map(ext => `${base}${ext}`), ...extensions.map(ext => join(base, `index${ext}`))].find(candidate => existsSync(candidate))
    if (target && importsCmsPreset(target, seen)) return true
  }
  return false
}

/**
 * Comments, Forms, Content, and the `cms` preset are on when the app has `server/comments.ts`, `server/forms/`, or
 * `server/content.ts`. This plugin fails the build when such a file exists but its package is not installed.
 */
export function optionalOwnerEntriesPlugin(options: { database?: boolean } = {}): Plugin {
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
      if (hasFormsDirectory(projectRoot, serverDirs)) {
        features.push("forms")
        if (options.database !== false) features.push("database")
      }
      if (content) features.push("content")
      if (content && importsCmsPreset(content)) features.push("cms", "database", "workspace")
      assertFeaturePackages([...new Set(features)])
    },
  }
}

/** With `comments: false`, a `server/comments.ts` would do nothing, so the build says so instead. */
export function commentsOffPlugin(): Plugin {
  return {
    name: "vite-hub/comments-off",
    configResolved(config) {
      // SAFETY: The resolved config keeps ViteHub's shared keys from the config hook.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[] }
      const projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(config.root)
      const file = findServerEntry(projectRoot, viteConfig[VITEHUB_SERVER_DIRS], "comments")
      if (file) throw viteHubErrorDiagnostics.VITE_HUB_B0019({ message: `[vitehub] \`comments: false\` turns Comments off, but the app has ${file}. Remove the file, or remove \`comments: false\`.` })
    },
  }
}

/** The `vite-hub` subpaths that re-export an optional owner package, by subpath root. */
const ownerFacadeFeatures = new Map<string, OptionalFeature>(Object.entries({
  "blob": "blob",
  "browser": "browser",
  "channels": "channels",
  "connections": "connections",
  "console/ui": "console ui",
  "decisions": "decisions",
  "email": "email",
  "forge": "forge",
  "forms": "forms",
  "gateways": "gateways",
  "kv": "kv",
  "markdown-template": "markdown-template",
  "mcp": "mcp",
  "presets": "presets",
  "queue": "queue",
  "rate-limit": "rateLimit",
  "sandbox": "sandboxTask",
  "shell": "shell",
  "ui": "ui",
  "workflow": "workflow",
} satisfies Record<string, OptionalFeature>))

const ownerFacade = new RegExp(`^vite-hub/(${[...ownerFacadeFeatures.keys()].join("|")})(?:/|$)`)
const markdownTemplateFile = /\.template\.md$/
const optionalOwnerImport = new RegExp(`${ownerFacade.source}|${markdownTemplateFile.source}`)

/** The feature of a `vite-hub` subpath that re-exports an optional owner package, such as `vite-hub/kv`. */
export function ownerFacadeFeature(specifier: string): OptionalFeature | undefined {
  const root = ownerFacade.exec(specifier)?.[1]
  return root === undefined ? undefined : ownerFacadeFeatures.get(root)
}

/**
 * The `vite-hub` facades of optional owners, such as `vite-hub/kv` and `vite-hub/ui`, import packages that the app
 * installs. A `.template.md` import needs `@vite-hub/markdown-template`. This plugin fails such an import with the
 * install command when the app did not install the packages.
 */
export function optionalOwnerImportsPlugin(): Plugin {
  return {
    name: "vite-hub/optional-owner-imports",
    enforce: "pre",
    resolveId: {
      filter: { id: optionalOwnerImport },
      handler(source) {
        const feature = markdownTemplateFile.test(source) ? "markdown-template" : ownerFacadeFeature(source)
        if (feature) assertFeaturePackages([feature])
      },
    },
  }
}
