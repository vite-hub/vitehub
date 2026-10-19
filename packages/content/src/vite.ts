import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { discoverContentDefinition, findContentEntry } from "@vite-hub/source/vite"
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

import { collectDatabaseContributions } from "@vite-hub/database/vite"
import type { DatabaseContributionContext, DatabaseContributionEntry, DatabaseContributionFactory } from "@vite-hub/database/vite"
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
  resolveCmsPreset(input: { projectRoot: string, serverDirs?: string[], databaseRoot?: string, contributedDefinitions?: readonly { name: string }[] }): Promise<CmsPresetPlan | undefined>
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

  async function resolveCmsPreset(input: { projectRoot: string, serverDirs?: string[], databaseRoot?: string, contributedDefinitions?: readonly { name: string }[] }): Promise<CmsPresetPlan | undefined> {
    const root = resolve(input.projectRoot)
    const file = await discoverContentDefinition({ projectRoot: root, serverDirs: input.serverDirs })
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
        const otherPlugins = context.plugins?.filter(plugin => Reflect.get(plugin, "name") !== CONTENT_VITE_PLUGIN_NAME)
        const databaseRoot = databaseDiscoveryRoot(otherPlugins, context.rootDir)
        const contributed = await collectDatabaseContributions(otherPlugins, { rootDir: databaseRoot, projectRoot: context.projectRoot, serverDirs: context.serverDirs ?? serverDirs, plugins: otherPlugins })
        const plan = await resolveCmsPreset({ databaseRoot, projectRoot: context.projectRoot, serverDirs: context.serverDirs ?? serverDirs, contributedDefinitions: contributed.definitions })
        const module = resolve(context.projectRoot, cmsWorkspaceModulePath)
        if (!plan) {
          await rm(module, { force: true })
          return []
        }
        await writeFileIfChanged(module, renderCmsWorkspaceModule(plan, imports))
        return [{ export: cmsWorkspaceExport, module, name: plan.workspace }]
      },
      async databases(context: DatabaseContributionContext) {
        const root = projectRoot ?? context.rootDir
        const otherPlugins = context.plugins?.filter(plugin => Reflect.get(plugin, "name") !== CONTENT_VITE_PLUGIN_NAME)
        const contributed = await collectDatabaseContributions(otherPlugins, context)
        const plan = await resolveCmsPreset({ databaseRoot: context.rootDir, projectRoot: root, serverDirs: serverDirs ?? context.serverDirs, contributedDefinitions: contributed.definitions })
        const module = resolve(root, cmsDatabaseModulePath)
        if (!plan || plan.databaseReason !== "preset") await rm(module, { force: true })
        if (!plan) return []
        const entries: DatabaseContributionEntry[] = [{ database: plan.database, export: "workspaceHistorySchema", module: imports.blobDatabase }]
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
}

type Node = Record<string, unknown> & { type?: unknown }

const contentModules: ReadonlySet<string> = new Set(["vite-hub/content", "@vite-hub/content"])

function isNode(value: unknown): value is Node {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function nodes(value: unknown): Node[] {
  return Array.isArray(value) ? value.filter(isNode) : []
}

function name(node: unknown): string | undefined {
  if (!isNode(node)) return
  if (node.type === "Identifier" && String(node.name) === node.name) return node.name
  if (node.type === "Literal" && String(node.value) === node.value) return node.value
}

/** Drops `as`, `satisfies`, `!`, and parentheses around an expression. */
function unwrap(node: unknown): unknown {
  let current = node
  while (isNode(current) && ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(current.type))) {
    current = current.expression
  }
  return current
}

/**
 * Whether a Content module may define document collections. It reads the `defineContent()` call that initializes the
 * `content` export and answers false only when it can tell that the call has no non-empty `collections` object.
 * Anything it cannot follow, such as options built by a function or imported from another file, counts as maybe.
 */
function contentModuleDefinesCollections(program: unknown): boolean {
  const body = isNode(program) ? nodes(program.body) : []
  const constants = new Map<string, unknown>()
  const defineContentNames = new Set<string>()
  let contentInit: unknown
  let contentLocal: string | undefined
  for (const statement of body) {
    if (statement.type === "ImportDeclaration" && isNode(statement.source) && contentModules.has(String(statement.source.value))) {
      for (const specifier of nodes(statement.specifiers)) {
        if (specifier.type === "ImportSpecifier" && name(specifier.imported) === "defineContent") {
          const local = name(specifier.local)
          if (local) defineContentNames.add(local)
        }
      }
    }
    const exported = statement.type === "ExportNamedDeclaration"
    const declaration = exported ? statement.declaration : statement
    if (isNode(declaration) && declaration.type === "VariableDeclaration") {
      for (const declarator of nodes(declaration.declarations)) {
        const local = name(declarator.id)
        if (!local) continue
        if (declaration.kind === "const") constants.set(local, declarator.init)
        if (exported && local === "content") contentInit = declarator.init
      }
    }
    if (exported && !statement.source) {
      for (const specifier of nodes(statement.specifiers)) {
        if (name(specifier.exported) === "content") contentLocal = name(specifier.local)
      }
    }
  }
  if (contentInit === undefined && contentLocal) contentInit = constants.get(contentLocal)
  const resolve = (node: unknown): unknown => {
    const value = unwrap(node)
    const local = isNode(value) && value.type === "Identifier" ? name(value) : undefined
    return local && constants.has(local) ? unwrap(constants.get(local)) : value
  }

  const call = unwrap(contentInit)
  if (!isNode(call) || call.type !== "CallExpression") return true
  const callee = name(unwrap(call.callee))
  if (!callee || !defineContentNames.has(callee)) return true
  const [argument, ...rest] = Array.isArray(call.arguments) ? call.arguments : []
  if (argument === undefined) return false
  const options = resolve(argument)
  if (rest.length || !isNode(options) || options.type !== "ObjectExpression") return true
  let collections: unknown
  for (const property of Array.isArray(options.properties) ? options.properties : []) {
    if (!isNode(property) || property.type !== "Property") return true
    if (!property.computed && name(property.key) === "collections") collections = property.value
  }
  if (collections === undefined) return false
  const value = resolve(collections)
  if (!isNode(value) || value.type !== "ObjectExpression") return true
  return Array.isArray(value.properties) && value.properties.length > 0
}

/** Finds the Content module of the project, but only when it may define document collections. */
async function findContentCollectionsEntry(options: ContentConsoleOptions): Promise<string | undefined> {
  const file = await findContentEntry(options)
  if (!file) return
  // `vite` is an optional peer. The Console discovers sections inside Vite, so it is installed there.
  const { parseAst } = await import("vite")
  let program: unknown
  try {
    program = parseAst(await readFile(file, "utf8"), { lang: /\.[cm]?ts$/.test(file) ? "ts" : "js" })
  }
  catch {
    // The runtime reports the syntax error. Keep the section so the editor shows it.
    return file
  }
  return contentModuleDefinesCollections(program) ? file : undefined
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
  icon: "i-lucide-file-pen-line",
  id: "content",
  label: "Content",
  view: {
    kind: "document-editor",
    notice: "Saves commit to the draft ref of the Content Workspace. Publishing copies documents to the published ref, which /api/content serves. content.can() decides what each user may read, write, and publish.",
  },
}
