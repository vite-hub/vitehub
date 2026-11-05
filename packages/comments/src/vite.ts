import { resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { validateCommentsDefinition } from "./operations-core/define.ts"
import { commentsErrorDiagnostics } from "./operations-core/errors.ts"

import { findCommentsEntry as findLiveEntry } from "./entry.ts"
import { hubComments as liveComments } from "./live-vite.ts"
import { findCommentsEntry as findOperationEntry } from "./operations-core/vite.ts"

import type { OperationContributions } from "@vite-hub/internal/operations"
import type { CommentsVitePluginOptions, CommentsVitePlugin as LivePlugin } from "./live-vite.ts"

export { injectLoader, loaderTag, loaderUrl, mountPath, overlayRoute, renderOverlayMiddleware, scriptNonce } from "./overlay.ts"
export type { CommentsOverlayAssets, CommentsOverlayOptions } from "./overlay.ts"

export { commentsConsoleSection } from "./console.ts"
export { mountedCommentsRoute } from "./page.ts"
export { commentsConsoleSection as commentsOperationsConsoleSection } from "./operations-core/console.ts"
export { COMMENTS_VITE_PLUGIN_NAME, usesComments } from "./operations-core/vite.ts"
export { comments, comments as default, commentsOverlayDirectory, componentNames, githubRepository, readCommentsBuild, readCommentsComponents, readCommentsDatabase, renderCommentsHandler, renderCommentsPlugin } from "./live-vite.ts"
export type { CommentsOptions, CommentsComponent, CommentsImports, CommentsRealtimeContributionContext, CommentsVitePluginOptions, StandaloneDatabase } from "./live-vite.ts"

export type HubCommentsOptions = CommentsVitePluginOptions & {
  /** Import paths of the comment operations. `vite-hub` passes its own subpaths. */
  operationsImports?: { operations?: string }
}
export type CommentsVitePlugin = LivePlugin & { vitehub: LivePlugin["vitehub"] & { operations: OperationContributions } }

export function findCommentsEntry(projectRoot: string, serverDirs?: readonly string[]): string | undefined
export function findCommentsEntry(options: { projectRoot: string, serverDirs?: readonly string[] }): string | undefined
export function findCommentsEntry(options: string | { projectRoot: string, serverDirs?: readonly string[] }, serverDirs?: readonly string[]): string | undefined {
  return typeof options === "string" ? findLiveEntry(options, serverDirs) : findOperationEntry(options)
}

/**
 * Comments in a ViteHub app, from one `server/comments.ts`: the Comments API and the overlay, presence rooms, the MCP
 * tools, and the comment operations of the Console, the CLI, and MCP. The file may export the definition as `comments`
 * or as its default export; both run every surface on the same tables.
 */
export function hubComments(options: HubCommentsOptions = {}): CommentsVitePlugin {
  const { operationsImports, ...liveOptions } = options
  const live = liveComments(liveOptions)
  const module = operationsImports?.operations ?? "@vite-hub/comments/operations"
  let projectRoot: string | undefined
  let serverDirs: readonly string[] | undefined
  const config = live.config
  return {
    ...live,
    config: {
      async handler(userConfig, environment) {
        const configuredRoot = Reflect.get(userConfig, VITEHUB_PROJECT_ROOT)
        projectRoot = typeof configuredRoot === "string" ? resolve(configuredRoot) : resolveViteHubProjectRoot(resolve(userConfig.root ?? process.cwd()))
        serverDirs = Reflect.get(userConfig, VITEHUB_SERVER_DIRS)
        return typeof config === "function" ? config.call(this, userConfig, environment) : config?.handler.call(this, userConfig, environment)
      },
    },
    // The shared page tools marker lets Comments and the Console add one SPA loader together, after other HTML changes.
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        const hook = live.transformIndexHtml
        return typeof hook === "function" ? hook.call(this, html, context) : hook?.handler.call(this, html, context)
      },
    },
    // The app may turn the Database off, and the file must export a definition: say so when Vite reads the config.
    async configResolved(resolved) {
      const entry = findCommentsEntry({ projectRoot: projectRoot ?? process.cwd(), ...(serverDirs ? { serverDirs } : {}) })
      if (!entry && !liveOptions.enabled) return
      const display = !entry ? "vitehub({ comments })" : entry.startsWith(`${projectRoot}/`) ? entry.slice((projectRoot ?? "").length + 1) : entry
      const hasDatabase = Reflect.get(resolved, VITEHUB_NITRO_CONFIG_CONTEXT) || resolved.plugins.some(plugin => plugin.name === "@vite-hub/database/vite")
      if (!hasDatabase) throw commentsErrorDiagnostics.COMMENTS_B0001({ file: display })
      if (!entry) return
      const { runnerImport } = await import("vite")
      const { module } = await runnerImport<{ comments?: unknown, default?: unknown }>(entry, { configFile: false, root: projectRoot, resolve: { alias: resolved.resolve?.alias }, logLevel: "silent" })
      validateCommentsDefinition(module.comments ?? module.default, display)
    },
    vitehub: {
      ...live.vitehub,
      // An app without server/comments.ts has nothing to comment on, unless `enabled` turns Comments on.
      operations: async () => liveOptions.enabled || findCommentsEntry({ projectRoot: projectRoot ?? process.cwd(), ...(serverDirs ? { serverDirs } : {}) })
        ? [{ export: "commentsOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).commentsOperations, module }]
        : [],
    },
  }
}
