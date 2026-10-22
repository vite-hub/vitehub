import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { findContentEntry, inspectContentEntry } from "@vite-hub/source/vite"
import { flattenPluginOptions } from "@vite-hub/internal/contributions"
import { parseAst } from "vite"

import {
  cmsDatabaseReason,
  cmsRequirementError,
  cmsWorkspaceExport,
  readCmsPresetUsageFile,
  renderCmsDatabaseModule,
  renderCmsWorkspaceModule,
  resolveCmsPresetPlan,
  usesCmsPresetSync,
} from "./cms-build.ts"

import type { DatabaseContributionContext, DatabaseContributionEntry, DatabaseContributionFactory } from "@vite-hub/database/vite"
import type { ViteHubConsoleDocumentEditorSection, ViteHubConsoleDocumentSetup } from "@vite-hub/internal/console"
import type { WorkspaceContributionContext, WorkspaceContributionFactory } from "@vite-hub/workspace/vite"
import type { Plugin, ResolvedConfig } from "vite"
import type { CmsPresetPlan, CmsWorkspaceImports } from "./cms-build.ts"

export { cmsPresetModules, readCmsPresetUsage, renderCmsDatabaseModule, renderCmsWorkspaceModule, resolveCmsPresetPlan } from "./cms-build.ts"
export type { CmsDatabaseChoices, CmsPresetPlan, CmsPresetUsage, CmsWorkspaceImports } from "./cms-build.ts"

export const CONTENT_VITE_PLUGIN_NAME = "@vite-hub/content/vite"

/** Generated Workspace Definition module of the `cms` preset, relative to the project root. */
export const cmsWorkspaceModulePath = ".vitehub/content/workspace.mjs"

/** Generated Database Definition that the `cms` preset adds when the app has none, relative to the project root. */
export const cmsDatabaseModulePath = ".vitehub/content/database.ts"

/**
 * Whether `server/content.ts` selects the `cms` preset. `vitehub()` reads it while Vite filters plugins, so the
 * preset turns on Workspace, Database, and Blob without settings. Reads the file without running it.
 */
export function usesCmsPreset(input: { projectRoot: string, serverDirs?: readonly string[] }): boolean {
  return usesCmsPresetSync(input, parseAst)
}

export interface ContentVitePluginOptions {
  /**
   * Import paths for the generated `cms` Workspace module. Defaults to the `@vite-hub/*` packages. The `vite-hub`
   * integration passes its own subpaths, so the module resolves from the app.
   */
  imports?: Partial<CmsWorkspaceImports>
}

export interface ContentVitePluginAPI {
  /** The resources that the `cms` preset uses, or undefined when `server/content.ts` does not select it. */
  resolveCmsPreset(input: { projectRoot: string, serverDirs?: readonly string[], databaseRoot?: string, contributedDefinitions?: readonly { name: string }[] }): Promise<CmsPresetPlan | undefined>
}

export type ContentVitePlugin = Plugin & {
  api: ContentVitePluginAPI
  /** Contributions that the Workspace and Database plugins collect. Empty without the `cms` preset. */
  vitehub: { databases: DatabaseContributionFactory, workspaces: WorkspaceContributionFactory }
}

interface ContentPluginConfig {
  root?: string
  [VITEHUB_PROJECT_ROOT]?: string
  [VITEHUB_SERVER_DIRS]?: string[]
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
}

const defaultImports: CmsWorkspaceImports = {
  blob: "@vite-hub/blob",
  blobDatabase: "@vite-hub/workspace/blob-database",
  contentDatabase: "@vite-hub/content/database",
  database: "@vite-hub/database/drizzle",
  databaseDefinition: "@vite-hub/database",
  workspace: "@vite-hub/workspace",
}

const workspacePluginName = "@vite-hub/workspace/vite"
const databasePluginName = "@vite-hub/database/vite"
const blobPluginName = "@vite-hub/blob/vite"

async function writeFileIfChanged(file: string, contents: string): Promise<void> {
  const current = await readFile(file, "utf8").catch(() => undefined)
  if (current === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

function absoluteDirs(root: string, directories: readonly string[] | undefined): string[] | undefined {
  return directories?.map(directory => resolve(root, directory))
}

function pluginByName(config: ResolvedConfig, name: string): Plugin | undefined {
  return config.plugins.find(plugin => plugin.name === name)
}

function databaseDiscoveryRoot(plugins: readonly unknown[] | undefined, fallback: string): string {
  const database = plugins?.find(plugin => Reflect.get(Object(plugin), "name") === databasePluginName)
  const api = Reflect.get(Object(database), "api")
  const getProjectRoot = Reflect.get(Object(api), "getProjectRoot")
  if (typeof getProjectRoot === "function") {
    const rootDir = Reflect.apply(getProjectRoot, undefined, [])
    if (typeof rootDir === "string") return rootDir
  }
  const getConfig = Reflect.get(Object(api), "getConfig")
  if (typeof getConfig === "function") {
    const rootDir = Reflect.get(Object(Reflect.apply(getConfig, database, [])), "rootDir")
    if (typeof rootDir === "string") return rootDir
  }
  return fallback
}

/**
 * The other plugins of the app. `vitehub()` nests the Content plugin in an array, and the Database contributions that
 * the hooks collect would call the hook again through that nested copy, so flatten first.
 */
async function pluginsWithoutContent(plugins: readonly unknown[] | undefined): Promise<object[]> {
  return (await flattenPluginOptions(plugins)).filter(plugin => Reflect.get(plugin, "name") !== CONTENT_VITE_PLUGIN_NAME)
}

/** Store names of the Blob plugin, or false when Blob is off. */
function blobStoreNames(plugin: Plugin | undefined): string[] | false {
  if (!plugin) return false
  const getConfig: unknown = Reflect.get(Object(Reflect.get(plugin, "api")), "getConfig")
  if (!(getConfig instanceof Function)) return false
  const blob: unknown = Reflect.get(Object(Reflect.apply(getConfig, undefined, [])), "blob")
  if (blob === null || Object(blob) !== blob) return false
  const stores: unknown = Reflect.get(Object(blob), "stores")
  return stores !== null && Object(stores) === stores ? Object.keys(Object(stores)) : ["default"]
}

/**
 * Content build integration. When `server/content.ts` selects the `cms` preset, it contributes the preset's Workspace
 * through `vitehub.workspaces`, and the Workspace history tables through `vitehub.databases`, with the `default`
 * Database Definition when the app has none. It checks that Workspace, Database, and Blob are enabled. Apps without
 * the preset are unaffected.
 */
export function hubContent(options: ContentVitePluginOptions = {}): ContentVitePlugin {
  const imports: CmsWorkspaceImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  let resolvedPlugins: readonly unknown[] | undefined

  async function resolveCmsPreset(input: { projectRoot: string, serverDirs?: readonly string[], databaseRoot?: string, contributedDefinitions?: readonly { name: string }[] }): Promise<CmsPresetPlan | undefined> {
    const root = resolve(input.projectRoot)
    const file = await findContentEntry({ projectRoot: root, serverDirs: input.serverDirs })
    if (!file) return
    const usage = await readCmsPresetUsageFile(file, root, parseAst)
    if (!usage) return
    // Loaded only for the preset, so importing the Vite config does not load Database dependencies such as Drizzle.
    const { discoverDatabaseDefinitions, resolveDefaultDatabase } = await import("@vite-hub/database/config")
    const databaseRoot = resolve(input.databaseRoot ?? root)
    const names = [
      ...discoverDatabaseDefinitions(databaseRoot, { serverDirs: absoluteDirs(root, input.serverDirs) }).map(definition => definition.name),
      ...(input.contributedDefinitions ?? []).map(definition => definition.name),
    ]
    return resolveCmsPresetPlan(usage, { names, resolveDefault: resolveDefaultDatabase }, root)
  }

  return {
    name: CONTENT_VITE_PLUGIN_NAME,
    api: { resolveCmsPreset },
    vitehub: {
      async workspaces(context: WorkspaceContributionContext) {
        const otherPlugins = await pluginsWithoutContent(context.plugins)
        const databaseRoot = databaseDiscoveryRoot(otherPlugins, context.root)
        // Only the Workspace and Database plugins call these hooks, so Database is installed whenever they run.
        const { collectDatabaseContributions } = await import("@vite-hub/database/vite")
        const contributed = await collectDatabaseContributions(otherPlugins, { root: databaseRoot, rootDir: databaseRoot, projectRoot: context.projectRoot, serverDirs: context.serverDirs ?? serverDirs, plugins: otherPlugins })
        const plan = await resolveCmsPreset({ databaseRoot, projectRoot: context.projectRoot, serverDirs: context.serverDirs ?? serverDirs, contributedDefinitions: contributed.definitions })
        const module = resolve(context.projectRoot, cmsWorkspaceModulePath)
        if (!plan) {
          await rm(module, { force: true })
          return []
        }
        await writeFileIfChanged(module, renderCmsWorkspaceModule(plan, imports))
        return [{ definition: { export: cmsWorkspaceExport, module }, name: plan.workspace, reason: "Stores the documents of the Content cms preset." }]
      },
      async databases(context: DatabaseContributionContext) {
        const root = projectRoot ?? context.projectRoot
        const otherPlugins = await pluginsWithoutContent(resolvedPlugins ?? context.plugins)
        const { collectDatabaseContributions } = await import("@vite-hub/database/vite")
        const contributed = await collectDatabaseContributions(otherPlugins, { ...context, rootDir: context.rootDir, projectRoot: root, plugins: otherPlugins })
        const plan = await resolveCmsPreset({ databaseRoot: context.rootDir, projectRoot: root, serverDirs: serverDirs ?? context.serverDirs?.slice(), contributedDefinitions: contributed.definitions })
        const module = resolve(root, cmsDatabaseModulePath)
        if (!plan || plan.databaseReason !== "preset") await rm(module, { force: true })
        if (!plan) return []
        const entries: DatabaseContributionEntry[] = [
          { database: plan.database, definition: { export: "workspaceHistorySchema", module: imports.blobDatabase }, name: "content-history", reason: "Stores the history of Content documents." },
          ...(imports.contentDatabase
            ? [{ database: plan.database, definition: { export: "contentSessionsSchema", module: imports.contentDatabase }, name: "content-sessions", reason: "Stores presence and edit leases of Content documents." }]
            : []),
        ]
        if (plan.databaseReason !== "preset") return entries
        await writeFileIfChanged(module, renderCmsDatabaseModule(imports))
        return [{ definition: module, name: plan.database, reason: cmsDatabaseReason(plan.file, root) }, ...entries]
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
    async configResolved(config) {
      // SAFETY: The resolved config keeps ViteHub's shared keys from the config hook.
      const viteConfig = config as ResolvedConfig & ContentPluginConfig
      resolvedPlugins = config.plugins
      projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(config.root)
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice() ?? serverDirs
      const plan = await resolveCmsPreset({ databaseRoot: config.root, projectRoot, serverDirs })
      if (!plan) return
      const missing = [
        pluginByName(config, workspacePluginName) ? undefined : "workspace",
        pluginByName(config, databasePluginName) || viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT] ? undefined : "database",
        blobStoreNames(pluginByName(config, blobPluginName)) ? undefined : "blob",
      ].filter(Boolean)
      if (missing.length) {
        const setting = missing.map(name => `${name}: true`).join(", ")
        throw cmsRequirementError(plan.file, projectRoot, `it needs ${missing.join(", ")} enabled. Set vitehub({ ${setting} }) in your Vite config.`)
      }
      const stores = blobStoreNames(pluginByName(config, blobPluginName)) || []
      if (!stores.includes(plan.blob)) {
        throw cmsRequirementError(plan.file, projectRoot, `it stores files in Blob store ${JSON.stringify(plan.blob)}, which is not configured. Blob stores: ${stores.map(name => JSON.stringify(name)).join(", ")}. Choose one with extends: [cms, { blob: ${JSON.stringify(stores[0])} }] or add the store to vitehub({ blob }).`)
      }
    },
    configureServer(server) {
      const root = projectRoot
      if (!root) return
      const directories = absoluteDirs(root, serverDirs) ?? [resolve(root, "server")]
      let current: Promise<string> = describePlan()
      async function describePlan(): Promise<string> {
        try {
          return JSON.stringify(await resolveCmsPreset({ databaseRoot: server.config.root, projectRoot: root!, serverDirs }) ?? null)
        }
        catch (error) {
          return `error:${error instanceof Error ? error.message : String(error)}`
        }
      }
      // Selecting, changing, or removing the preset changes the generated Workspace and tables, so restart.
      const onChange = (file: string) => {
        const path = resolve(file)
        if (!directories.some(directory => dirname(path) === directory) || !/[\\/]content\.[cm]?[jt]s$/.test(path)) return
        const previous = current
        current = describePlan()
        void Promise.all([previous, current]).then(async ([before, after]) => {
          if (before !== after) await server.restart()
        }).catch(error => server.config.logger.error(String(error)))
      }
      server.watcher.on("add", onChange)
      server.watcher.on("change", onChange)
      server.watcher.on("unlink", onChange)
    },
  }
}

export interface ContentConsoleOptions {
  projectRoot: string
  /** Server directories to search, relative to `projectRoot`. Defaults to `server`. */
  serverDirs?: string[]
  /**
   * Files of the Schedule Definitions that the project runs, from Schedule discovery. Undefined when the project does
   * not enable Schedule, so no Schedule Definition runs.
   */
  schedules?: readonly string[]
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
  return (await inspectContentEntry(file)).collections ? file : undefined
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
