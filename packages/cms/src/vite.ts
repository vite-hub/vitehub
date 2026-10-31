import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { flattenPluginOptions } from "@vite-hub/internal/contributions"
import { findContentEntry } from "@vite-hub/source/vite"
import { parseAst } from "vite"

import {
  cmsDatabaseReason,
  cmsPresetStoreSync,
  cmsRequirementError,
  cmsWorkspaceExport,
  readCmsPresetUsageFile,
  renderCmsDatabaseModule,
  renderCmsWorkspaceModule,
  resolveCmsPresetPlan,
  usesCmsPresetSync,
} from "./build.ts"

import type { DatabaseContributionContext, DatabaseContributionEntry, DatabaseContributionFactory } from "@vite-hub/database/vite"
import type { WorkspaceContributionContext, WorkspaceContributionFactory } from "@vite-hub/workspace/vite"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type { CmsPresetPlan, CmsWorkspaceImports } from "./build.ts"

export { cmsPresetModules, readCmsPresetUsage, renderCmsDatabaseModule, renderCmsWorkspaceModule, resolveCmsPresetPlan } from "./build.ts"
export type { CmsDatabaseChoices, CmsGitHubPlan, CmsPresetPlan, CmsPresetUsage, CmsWorkspaceImports } from "./build.ts"

export const CMS_VITE_PLUGIN_NAME = "@vite-hub/cms/vite"

/** Generated Workspace Definition module of the `cms` preset, relative to the project root. */
export const cmsWorkspaceModulePath = ".vitehub/content/workspace.mjs"

/** Generated Database Definition that the `cms` preset adds when the app has none, relative to the project root. */
export const cmsDatabaseModulePath = ".vitehub/content/database.ts"

/**
 * Whether `server/content.ts` selects the `cms` preset. `vitehub()` reads it while Vite filters plugins, so the
 * preset turns on Workspace, Database, and Blob without settings. Reads the file without running it.
 */
export function usesCms(input: { projectRoot: string, serverDirs?: readonly string[] }): boolean {
  return usesCmsPresetSync(input, parseAst)
}

/** The selected CMS store, so framework integrations enable only the services it needs. */
export function cmsStore(input: { projectRoot: string, serverDirs?: readonly string[] }): "blob-database" | "github" | undefined {
  return cmsPresetStoreSync(input, parseAst)
}

export interface CmsVitePluginOptions {
  /**
   * Import paths for the generated `cms` Workspace module. Defaults to the `@vite-hub/*` packages. The `vite-hub`
   * integration passes its own subpaths, so the module resolves from the app.
   */
  imports?: Partial<CmsWorkspaceImports>
}

export interface CmsVitePluginAPI {
  /** The resources that the `cms` preset uses, or undefined when `server/content.ts` does not select it. */
  resolvePlan(input: { projectRoot: string, serverDirs?: readonly string[], databaseRoot?: string, contributedDefinitions?: readonly { name: string }[] }): Promise<CmsPresetPlan | undefined>
}

export type CmsVitePlugin = Plugin & {
  api: CmsVitePluginAPI
  /** Contributions that the Workspace and Database plugins collect. Both are empty without the `cms` preset. */
  vitehub: { databases: DatabaseContributionFactory, workspaces: WorkspaceContributionFactory }
}

type CmsPluginConfig = UserConfig & {
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
 * The other plugins of the app. `vitehub()` nests the CMS plugin in an array, and the Database contributions that
 * the hooks collect would call the hook again through that nested copy, so flatten first.
 */
async function pluginsWithoutCms(plugins: readonly unknown[] | undefined): Promise<object[]> {
  return (await flattenPluginOptions(plugins)).filter(plugin => Reflect.get(plugin, "name") !== CMS_VITE_PLUGIN_NAME)
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
 * CMS build integration. When `server/content.ts` selects the `cms` preset, it contributes the preset's Workspace
 * through `vitehub.workspaces`, and the Workspace history tables through `vitehub.databases`, with the `default`
 * Database Definition when the app has none. It checks that Workspace, Database, and Blob are enabled, and restarts the
 * dev server when the selection changes. Apps without the preset are unaffected.
 */
export function hubCms(options: CmsVitePluginOptions = {}): CmsVitePlugin {
  const imports: CmsWorkspaceImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  let resolvedPlugins: readonly unknown[] | undefined

  async function resolvePlan(input: { projectRoot: string, serverDirs?: readonly string[], databaseRoot?: string, contributedDefinitions?: readonly { name: string }[] }): Promise<CmsPresetPlan | undefined> {
    const root = resolve(input.projectRoot)
    const file = await findContentEntry({ projectRoot: root, serverDirs: input.serverDirs?.slice() })
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
    name: CMS_VITE_PLUGIN_NAME,
    enforce: "post",
    api: { resolvePlan },
    vitehub: {
      async workspaces(context: WorkspaceContributionContext) {
        // Nuxt may omit ViteHub project-root metadata; use the Vite root then.
        const projectRoot = context.projectRoot ?? context.root
        const otherPlugins = await pluginsWithoutCms(context.plugins)
        const databaseRoot = databaseDiscoveryRoot(otherPlugins, projectRoot)
        const { collectDatabaseContributions } = await import("@vite-hub/database/vite")
        const contributed = await collectDatabaseContributions(otherPlugins, { root: context.root, rootDir: databaseRoot, projectRoot, serverDirs: context.serverDirs ?? serverDirs, plugins: otherPlugins })
        const plan = await resolvePlan({ databaseRoot, projectRoot, serverDirs: context.serverDirs ?? serverDirs, contributedDefinitions: contributed.definitions })
        const module = resolve(projectRoot, cmsWorkspaceModulePath)
        if (!plan) {
          await rm(module, { force: true })
          return []
        }
        await writeFileIfChanged(module, renderCmsWorkspaceModule(plan, imports))
        return [{ definition: { export: cmsWorkspaceExport, module }, name: plan.workspace, reason: "Stores the documents of the Content cms preset." }]
      },
      async databases(context: DatabaseContributionContext) {
        const root = projectRoot ?? context.projectRoot ?? context.rootDir ?? context.root ?? process.cwd()
        const otherPlugins = await pluginsWithoutCms(resolvedPlugins ?? context.plugins)
        const { collectDatabaseContributions } = await import("@vite-hub/database/vite")
        const contributed = await collectDatabaseContributions(otherPlugins, { ...context, rootDir: context.rootDir ?? root, projectRoot: context.projectRoot ?? root, plugins: otherPlugins })
        const plan = await resolvePlan({ databaseRoot: context.rootDir ?? root, projectRoot: root, serverDirs: serverDirs ?? context.serverDirs?.slice(), contributedDefinitions: contributed.definitions })
        const module = resolve(root, cmsDatabaseModulePath)
        if (!plan || plan.databaseReason !== "preset") await rm(module, { force: true })
        if (!plan) return []
        // The GitHub store keeps history in Git. Only editor sessions need tables.
        const entries: DatabaseContributionEntry[] = [
          ...(plan.store === "github"
            ? []
            : [{ database: plan.database, definition: { export: "workspaceHistorySchema", module: imports.blobDatabase }, name: "content-history", reason: "Stores the history of Content documents." }]),
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
        const viteConfig = config as CmsPluginConfig
        projectRoot = viteConfig[VITEHUB_PROJECT_ROOT]
          ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
          : resolveViteHubProjectRoot(viteConfig.root || process.cwd())
        serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice()
      },
    },
    async configResolved(config) {
      // SAFETY: The resolved config keeps ViteHub's shared keys from the config hook.
      const viteConfig = config as ResolvedConfig & CmsPluginConfig
      resolvedPlugins = config.plugins
      projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(config.root)
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice() ?? serverDirs
      const plan = await resolvePlan({ databaseRoot: config.root, projectRoot, serverDirs })
      if (!plan) return
      const missing = [
        pluginByName(config, workspacePluginName) ? undefined : "workspace",
        pluginByName(config, databasePluginName) || viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT] ? undefined : "database",
        plan.store === "github" || blobStoreNames(pluginByName(config, blobPluginName)) ? undefined : "blob",
      ].filter(Boolean)
      if (missing.length) {
        const setting = missing.map(name => `${name}: true`).join(", ")
        throw cmsRequirementError(plan.file, projectRoot, `it needs ${missing.join(", ")} enabled. Set vitehub({ ${setting} }) in your Vite config.`)
      }
      if (plan.store === "github" || plan.blob === undefined) return
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
          return JSON.stringify(await resolvePlan({ databaseRoot: server.config.root, projectRoot: root!, serverDirs }) ?? null)
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

export default hubCms
