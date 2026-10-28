import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { scanModule } from "@vite-hub/internal/build/scan-module"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { findCommentsEntry as findLiveEntry } from "./entry.ts"
import { hubComments as liveComments } from "./live-vite.ts"
import { hubComments as operationComments, findCommentsEntry as findOperationEntry } from "./operations-core/vite.ts"

import type { DatabaseContributionContext } from "@vite-hub/database/vite"
import type { CommentsRealtimeContributionContext, CommentsVitePluginOptions, CommentsVitePlugin as LivePlugin } from "./live-vite.ts"
import type { HubCommentsOptions as OperationOptions, CommentsVitePlugin as OperationPlugin } from "./operations-core/vite.ts"

export { injectLoader, loaderTag, loaderUrl, mountPath, overlayRoute, renderOverlayMiddleware, scriptNonce } from "./overlay.ts"
export type { CommentsOverlayAssets, CommentsOverlayOptions } from "./overlay.ts"
export { commentsOverlayMiddlewarePath } from "./operations-core/vite.ts"

export { commentsConsoleSection } from "./console.ts"
export { commentsConsoleSection as commentsOperationsConsoleSection } from "./operations-core/console.ts"
export { COMMENTS_VITE_PLUGIN_NAME, commentsNitroPluginPath, commentsDatabaseModulePath, renderCommentsDatabaseModule, renderCommentsNitroPlugin, usesComments } from "./operations-core/vite.ts"
export { readCommentsDatabase, renderCommentsHandler, renderCommentsPlugin } from "./live-vite.ts"
export type { CommentsImports, CommentsRealtimeContributionContext, CommentsVitePluginOptions } from "./live-vite.ts"

export type HubCommentsOptions = Omit<OperationOptions, "imports"> & CommentsVitePluginOptions & {
  operationsImports?: OperationOptions["imports"]
}
export type CommentsVitePlugin = OperationPlugin & { api: LivePlugin["api"] }

export function findCommentsEntry(projectRoot: string, serverDirs?: readonly string[]): string | undefined
export function findCommentsEntry(options: { projectRoot: string, serverDirs?: readonly string[] }): string | undefined
export function findCommentsEntry(options: string | { projectRoot: string, serverDirs?: readonly string[] }, serverDirs?: readonly string[]): string | undefined {
  return typeof options === "string" ? findLiveEntry(options, serverDirs) : findOperationEntry(options)
}

/** A default export opts into Operations; the named `comments` export retains the live-site API. */
export function commentsEntryMode(file: string): "operations" | "live" {
  const module = scanModule(readFileSync(file, "utf8"), file)
  let named = false
  for (const statement of module.program.body) {
    if (statement.type === "ExportDefaultDeclaration") return "operations"
    if (statement.type === "ExportNamedDeclaration" && statement.specifiers.some(specifier => (specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value) === "default")) return "operations"
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration?.type === "VariableDeclaration" && statement.declaration.declarations.some(declaration => declaration.id.type === "Identifier" && declaration.id.name === "comments")) named = true
      if (statement.specifiers.some(specifier => (specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value) === "comments")) named = true
    }
  }
  return named ? "live" : "operations"
}

/** Select one runtime and schema so the two entry forms never install competing thread tables. */
export function hubComments(options: HubCommentsOptions = {}): CommentsVitePlugin {
  const operations = operationComments({ ...options, imports: options.operationsImports })
  const live = liveComments(options)
  let projectRoot: string | undefined
  let serverDirs: readonly string[] | undefined
  function select(context?: DatabaseContributionContext): OperationPlugin | LivePlugin {
    const root = projectRoot ?? context?.projectRoot ?? context?.rootDir ?? process.cwd()
    const entry = findCommentsEntry({ projectRoot: root, serverDirs: serverDirs ?? context?.serverDirs })
    return entry && commentsEntryMode(entry) === "live" ? live : operations
  }
  return {
    name: operations.name,
    enforce: "pre",
    api: {
      async contributeRealtime(context: CommentsRealtimeContributionContext) {
        const entry = findCommentsEntry({ projectRoot: context.projectRoot, serverDirs: context.serverDirs })
        if (entry && commentsEntryMode(entry) === "live") return live.api.contributeRealtime(context)
      },
    },
    config: {
      async handler(config, environment) {
        const configuredRoot = Reflect.get(config, VITEHUB_PROJECT_ROOT)
        projectRoot = typeof configuredRoot === "string" ? resolve(configuredRoot) : resolveViteHubProjectRoot(resolve(config.root ?? process.cwd()))
        serverDirs = Reflect.get(config, VITEHUB_SERVER_DIRS)
        const hook = select().config
        return typeof hook === "function" ? hook.call(this, config, environment) : hook?.handler.call(this, config, environment)
      },
    },
    async configResolved(config) {
      const hook = select().configResolved
      if (typeof hook === "function") await hook.call(this, config)
      else await hook?.handler.call(this, config)
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const hook = select().transformIndexHtml
        return typeof hook === "function" ? hook.call(this, html, context) : hook?.handler.call(this, html, context)
      },
    },
    vitehub: {
      databases: context => select(context).vitehub.databases(context),
      inspect: () => {
        const inspect = select().vitehub.inspect
        return typeof inspect === "function" ? inspect() : inspect
      },
      operations: async () => {
        if (select() !== operations) return []
        const contributions = operations.vitehub.operations
        return typeof contributions === "function" ? contributions() : contributions
      },
    },
  }
}
