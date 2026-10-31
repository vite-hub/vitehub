import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { findContentEntry, inspectContentEntry } from "@vite-hub/source/vite"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ViteHubConsoleDocumentEditorSection, ViteHubConsoleDocumentSetup } from "@vite-hub/internal/console"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { OperationContributions } from "@vite-hub/internal/operations"
import type { Plugin, UserConfig } from "vite"

export const CONTENT_VITE_PLUGIN_NAME = "@vite-hub/content/vite"

export type ContentVitePlugin = Plugin & {
  /** The `vitehub content` commands, the Content operations, and the Content Definition inspector. */
  vitehub: { operations: OperationContributions } & ViteHubCliPluginMetadata & ViteHubInspectionPluginMetadata
}

type ContentPluginConfig = UserConfig & {
  [VITEHUB_PROJECT_ROOT]?: string
  [VITEHUB_SERVER_DIRS]?: string[]
}

/**
 * Content build integration. When the app defines `server/content.ts`, it adds the `vitehub content` commands, the
 * Content operations, and the Content Definition inspector. The `cms` preset and the infrastructure it needs come from
 * `@vite-hub/cms/vite`.
 */
export function hubContent(): ContentVitePlugin {
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  const discover = () => findContentEntry({ projectRoot: projectRoot ?? process.cwd(), serverDirs })

  return {
    name: CONTENT_VITE_PLUGIN_NAME,
    enforce: "post",
    vitehub: {
      // The Console, `vitehub content`, and agents run these. The app imports them through `vite-hub`.
      // An app without server/content.ts has no Content to operate on, so it contributes nothing.
      operations: async () => await discover()
        ? [{ export: "contentOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).contentOperations, module: "@vite-hub/content/operations" }]
        : [],
      cli: async () => {
        if (!await discover()) return
        const { createContentCliContributor } = await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./cli.ts" : "./cli.js")
        return createContentCliContributor()
      },
      inspect: async () => {
        const definition = await discover()
        if (!definition) return
        const features = await inspectContentEntry(definition)
        return {
          definitions: [{
            kind: "content",
            label: "Content",
            list: () => [{
              fields: [
                { label: "Route", value: features.route ? "/api/content/**" : "Disabled" },
                { label: "Collections", value: "vitehub content collections" },
              ],
              file: relativeDefinitionFile(projectRoot ?? process.cwd(), definition),
              name: "content",
              source: "server-content",
            }],
          }],
        }
      },
    },
    config: {
      order: "pre",
      handler(config) {
        // SAFETY: Vite passes its user config with ViteHub's shared keys attached.
        const viteConfig = config as ContentPluginConfig
        projectRoot = viteConfig[VITEHUB_PROJECT_ROOT]
          ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
          : resolveViteHubProjectRoot(viteConfig.root || process.cwd())
        serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice()
      },
    },
    configResolved(config) {
      // SAFETY: The resolved config keeps ViteHub's shared keys from the config hook.
      const viteConfig = config as typeof config & ContentPluginConfig
      projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(config.root)
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice() ?? serverDirs
    },
  }
}

export interface ContentConsoleOptions {
  projectRoot: string
  contentImportBase?: string
  /** Server directories to search, relative to `projectRoot`. Defaults to `server`. */
  serverDirs?: string[]
  /**
   * Files of the Schedule Definitions that the project runs, from Schedule discovery. Undefined when the project does
   * not enable Schedule, so no Schedule Definition runs.
   */
  schedules?: readonly string[]
  /**
   * False when the Workspace store of the collections cannot schedule publishes, such as the GitHub store of the
   * `cms` preset. The Console then does not ask for a Schedule Definition that calls `content.publishDue()`.
   */
  scheduling?: boolean
}

type AstNode = Record<string, unknown>

function isAstNode(value: unknown): value is AstNode {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

/** Whether a parsed module calls a member named `publishDue`, such as `content.publishDue()`, anywhere. */
function callsPublishDue(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(callsPublishDue)
  if (!isAstNode(node)) return false
  if (node.type === "CallExpression" && isAstNode(node.callee) && node.callee.type === "MemberExpression") {
    const property = node.callee.property
    const name = isAstNode(property) ? (node.callee.computed ? property.value : property.name) : undefined
    if (name === "publishDue") return true
  }
  return Object.entries(node).some(([key, value]) => key !== "type" && Object(value) === value && callsPublishDue(value))
}

/**
 * The Schedule Definition that runs scheduled Content publishes: the first file that calls `publishDue()`, such as
 * `handler: () => content.publishDue()`. Discovery reads the files without running them, so the call must be in the
 * Schedule Definition file itself. Returns undefined when no file calls it.
 */
export async function findContentPublishRunner(schedules: readonly string[]): Promise<string | undefined> {
  // `vite` is an optional peer. Discovery runs inside Vite, so it is installed there.
  const { parseAst } = await import("vite")
  for (const file of schedules) {
    let source: string
    try {
      source = await readFile(file, "utf8")
    }
    catch {
      continue
    }
    // A file without the name cannot call it, so most files skip the parse.
    if (!source.includes("publishDue")) continue
    try {
      if (callsPublishDue(parseAst(source, { lang: /\.[cm]?ts$/.test(file) ? "ts" : "js" }))) return file
    }
    catch {
      // Schedule reports the syntax error.
    }
  }
}

/**
 * What the Content editor lacks, read without running the app. Scheduled publishes need a Schedule Definition that calls
 * `content.publishDue()`; without one, schedules never publish and only turn overdue.
 */
async function inspectContentSetup(options: ContentConsoleOptions): Promise<ViteHubConsoleDocumentSetup> {
  if (options.scheduling === false) return {}
  if (options.schedules && await findContentPublishRunner(options.schedules)) return {}
  return {
    schedule: {
      message: options.schedules
        ? "Nothing publishes scheduled documents. Add a Schedule Definition that calls `content.publishDue()`."
        : "Nothing publishes scheduled documents. Enable Schedule and add a Schedule Definition that calls `content.publishDue()`.",
      docs: "https://vitehub.dev/docs/content/scheduling#run-due-schedules",
    },
  }
}

/**
 * Finds the Content module of the project, but only when it may define document collections. Discovery reads the
 * `defineContent()` call without running it; anything it cannot follow, such as options imported from another file,
 * counts as maybe.
 */
async function findContentCollectionsEntry(options: ContentConsoleOptions): Promise<string | undefined> {
  const file = await findContentEntry(options)
  if (!file) return
  return (await inspectContentEntry(file, options.contentImportBase)).collections ? file : undefined
}

/**
 * Console section for Content. It edits the document collections of the `content` export of `server/content.ts`.
 * Every action checks `content.can()` with the signed-in Console user. The Console shows the section only when
 * `defineContent()` defines document collections; a Content file with only read-only Sources has nothing to edit.
 */
export const contentConsoleSection: ViteHubConsoleDocumentEditorSection<ContentConsoleOptions> = {
  actions: { export: "createContentConsoleActions", module: "@vite-hub/content/runtime/console" },
  description: "Edit, publish, and restore Content documents.",
  entry: options => findContentCollectionsEntry(options),
  inspect: options => inspectContentSetup(options),
  icon: "i-lucide-file-pen-line",
  id: "content",
  label: "Content",
  pages: [
    { id: "dashboard", label: "Dashboard", icon: "i-lucide-layout-dashboard", index: true, view: { kind: "document-dashboard" } },
    { id: "settings", label: "Settings", icon: "i-lucide-settings-2", group: "Manage", view: { kind: "document-settings" } },
    { id: "media", label: "Media", icon: "i-lucide-image", group: "Manage", requires: ["blob"], view: { kind: "media-library" } },
  ],
  view: {
    kind: "document-editor",
    notice: "Saves commit to the draft ref of the Content Workspace. Publishing copies documents to the published ref, which /api/content serves. content.can() decides what each user may read, write, and publish.",
  },
}

/** Where ViteHub generates the Content Realtime Definition. Realtime calls it only when the build has a room authority. */
export interface ContentRealtimeContributionOptions {
  /** The room authority: Durable Objects on Cloudflare, or one process. */
  authority: "cloudflare" | "memory"
  /** Directory for the generated files, such as `.vitehub/nitro/realtime`. */
  directory: string
  projectRoot: string
  serverDirs?: string[]
  /** Module that exports `contentRealtime` and `installContentLive`, such as `vite-hub/content/realtime`. */
  contentImport: string
  /** Module that exports `refreshRealtimeDocument`, such as `vite-hub/realtime/server`. */
  realtimeImport: string
  /** The identity and access of the Console, when the Console edits Content: a module and its `consoleRealtimeAccess` export. */
  console?: { module: string, section: string }
}

/** The name of the Realtime Definition that serves Content documents. */
export const contentRealtimeDefinitionName = "content"

/**
 * The Realtime Definition and Nitro plugin of Content live editing, when the project defines Content collections and
 * does not set `live: false`. The definition serves rooms `<collection>/<id>` with `contentRealtime()`; the plugin
 * installs live editing in each server process, so Content writes from outside a room refresh it and the Console
 * knows to join rooms. Returns undefined when Content has nothing to edit live.
 */
export async function contributeContentRealtime(options: ContentRealtimeContributionOptions): Promise<{ definitions: Array<{ handler: string, name: string }>, plugins: string[] } | undefined> {
  const file = await findContentEntry(options)
  if (!file) return
  const features = await inspectContentEntry(file)
  if (!features.collections || !features.live) return
  const definition = join(options.directory, "content.mjs")
  const plugin = join(options.directory, "content-live.mjs")
  const name = JSON.stringify(contentRealtimeDefinitionName)
  await mkdir(options.directory, { recursive: true })
  await Promise.all([
    writeFile(definition, [
      `import { content } from ${JSON.stringify(pathToFileURL(file).href)}`,
      `import { contentRealtime } from ${JSON.stringify(options.contentImport)}`,
      ...(options.console
        ? [
            `import { consoleRealtimeAccess } from ${JSON.stringify(options.console.module)}`,
            "",
            "// The Console session names the people in a room, and Console section access gates it before content.can().",
            `export default contentRealtime(content, consoleRealtimeAccess(${JSON.stringify(options.console.section)}))`,
          ]
        : ["", "export default contentRealtime(content)"]),
      "",
    ].join("\n")),
    writeFile(plugin, [
      `import { installContentLive } from ${JSON.stringify(options.contentImport)}`,
      `import { refreshRealtimeDocument } from ${JSON.stringify(options.realtimeImport)}`,
      ...(options.authority === "cloudflare"
        ? [
            'import { env } from "cloudflare:workers"',
            "",
            "export default function viteHubContentLive() {",
            `  installContentLive({ definition: ${name}, refresh: documentId => refreshRealtimeDocument(${name}, documentId, { durableObjects: env.$DurableObject }) })`,
            "}",
          ]
        : [
            "",
            "export default function viteHubContentLive() {",
            `  installContentLive({ definition: ${name}, refresh: documentId => refreshRealtimeDocument(${name}, documentId) })`,
            "}",
          ]),
      "",
    ].join("\n")),
  ])
  return { definitions: [{ handler: definition, name: contentRealtimeDefinitionName }], plugins: [plugin] }
}
