import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { discoverContentDefinition } from "@vite-hub/source/vite"

import { cmsRequirementError, cmsWorkspaceExport, readCmsPresetUsageFile, renderCmsWorkspaceModule, resolveCmsPresetPlan } from "./cms-build.ts"

import type { DatabaseContributionContext, DatabaseContributionFactory } from "@vite-hub/database/vite"
import type { WorkspaceContributionContext, WorkspaceContributionFactory } from "@vite-hub/workspace/vite"
import type { Plugin, ResolvedConfig } from "vite"
import type { CmsPresetPlan, CmsWorkspaceImports } from "./cms-build.ts"

export { cmsPresetModules, readCmsPresetUsage, resolveCmsPresetPlan, renderCmsWorkspaceModule } from "./cms-build.ts"
export type { CmsDatabaseChoices, CmsPresetPlan, CmsPresetUsage, CmsWorkspaceImports } from "./cms-build.ts"

export const CONTENT_VITE_PLUGIN_NAME = "@vite-hub/content/vite"

/** Generated Workspace Definition module of the `cms` preset, relative to the project root. */
export const cmsWorkspaceModulePath = ".vitehub/content/workspace.mjs"

export interface ContentVitePluginOptions {
  /**
   * Import paths for the generated `cms` Workspace module. Defaults to the `@vite-hub/*` packages. The `vite-hub`
   * integration passes its own subpaths, so the module resolves from the app.
   */
  imports?: Partial<CmsWorkspaceImports>
}

export interface ContentVitePluginAPI {
  /** The resources that the `cms` preset uses, or undefined when `server/content.ts` does not select it. */
  resolveCmsPreset(input: { projectRoot: string, serverDirs?: string[], databaseRoot?: string }): Promise<CmsPresetPlan | undefined>
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
}

const defaultImports: CmsWorkspaceImports = {
  blob: "@vite-hub/blob",
  blobDatabase: "@vite-hub/workspace/blob-database",
  database: "@vite-hub/database/drizzle",
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
 * through `vitehub.workspaces` and the Workspace history tables through `vitehub.databases`, and checks that
 * Workspace, Database, and Blob are enabled. Apps without the preset are unaffected.
 */
export function hubContent(options: ContentVitePluginOptions = {}): ContentVitePlugin {
  const imports: CmsWorkspaceImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined

  async function resolveCmsPreset(input: { projectRoot: string, serverDirs?: string[], databaseRoot?: string }): Promise<CmsPresetPlan | undefined> {
    const root = resolve(input.projectRoot)
    const file = await discoverContentDefinition({ projectRoot: root, serverDirs: input.serverDirs })
    if (!file) return
    const { parseAst } = await import("vite")
    const usage = await readCmsPresetUsageFile(file, root, parseAst)
    if (!usage) return
    // Loaded only for the preset, so importing the Vite config does not load Database dependencies such as Drizzle.
    const { discoverDatabaseDefinitions, resolveDefaultDatabase } = await import("@vite-hub/database/config")
    const databaseRoot = resolve(input.databaseRoot ?? root)
    const names = discoverDatabaseDefinitions(databaseRoot, { serverDirs: absoluteDirs(root, input.serverDirs) }).map(definition => definition.name)
    return resolveCmsPresetPlan(usage, { names, resolveDefault: resolveDefaultDatabase }, root)
  }

  return {
    name: CONTENT_VITE_PLUGIN_NAME,
    api: { resolveCmsPreset },
    vitehub: {
      async workspaces(context: WorkspaceContributionContext) {
        const plan = await resolveCmsPreset({ databaseRoot: context.rootDir, projectRoot: context.projectRoot, serverDirs: context.serverDirs ?? serverDirs })
        const module = resolve(context.projectRoot, cmsWorkspaceModulePath)
        if (!plan) {
          await rm(module, { force: true })
          return []
        }
        await writeFileIfChanged(module, renderCmsWorkspaceModule(plan, imports))
        return [{ export: cmsWorkspaceExport, module, name: plan.workspace }]
      },
      async databases(context: DatabaseContributionContext) {
        const plan = await resolveCmsPreset({ databaseRoot: context.rootDir, projectRoot: projectRoot ?? context.rootDir, serverDirs: serverDirs ?? context.serverDirs })
        if (!plan) return []
        return [{ database: plan.database, export: "workspaceHistorySchema", module: imports.blobDatabase }]
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
      projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(config.root)
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice() ?? serverDirs
      const plan = await resolveCmsPreset({ databaseRoot: config.root, projectRoot, serverDirs })
      if (!plan) return
      const missing = [
        pluginByName(config, workspacePluginName) ? undefined : "workspace",
        pluginByName(config, databasePluginName) ? undefined : "database",
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
