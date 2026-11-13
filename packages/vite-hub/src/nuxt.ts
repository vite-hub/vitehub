import { defaultDatabaseD1Binding, withComments, withConnectionsDatabase, withDataDir } from "./storage-config.ts"
import { assertAgentInvocationsRetention, assertAgentInvocationsUrl, defaultJournalNeedsLibsql, VITEHUB_AGENT_JOURNAL_D1, writeAgentInvocationsNitroPlugin } from "./agent-invocations-vite.ts"
import { isDefaultAgentJournal } from "./agent-invocations-setting.ts"
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { findPackageJSON } from "node:module"
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { parseJSONC } from "confbox/jsonc"
import { parseTOML } from "confbox/toml"
import { findNearestFile } from "pkg-types"
import { ownModule } from "@vite-hub/internal/build/paths"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { addViteHubDevPeerDevHandler, addViteHubDevPeerUpgradeSigner, type ViteHubDevPeerUpgradeServer } from "@vite-hub/internal/dev-peer"
import { getResolvedFeatureOptions, resolveNuxtServerDirs, resolveViteHubProjectRoot, VITEHUB_APP_BASE_URL, VITEHUB_GENERATED_ROOT, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PREPARE, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS, type NuxtServerDirOptions } from "@vite-hub/internal/build/vite"
import { removeViteHubDevServerFile, writeViteHubDevServerFile } from "@vite-hub/internal/cli"
import { describeDeploymentPlanOutput } from "@vite-hub/internal/build/deployment-plan-output"
import { generatedModules } from "./internal/generated-modules.ts"
import { nitroOptionalPeers } from "./internal/nitro-optional-peers.ts"
import { nitroCacheBypass } from "@vite-hub/internal/build/nitro-cache-bypass"
import { detectPreset, normalizeNitroPreset, resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import { cloudflareExportConditions } from "./deployment.ts"
import { isPlainObject as isRecord } from "@vite-hub/internal/object"
import { nuxtPageRoutes } from "@vite-hub/bundle/vite"
import { createEnvImportAliases } from "@vite-hub/env/vite"
import { mergeGeneratedSourceNitroConfig, type GeneratedSourceHandler } from "@vite-hub/source/vite"
import { mergeConfig } from "vite"

import { isIncludedNitroPlugin } from "@vite-hub/internal/build/included-nitro-registry"
import { viteHubPlugins, type ViteHubOptions } from "./plugins.ts"
import { markCmsPresetFeaturesResolved, resolveCmsPresetFeatures } from "./internal/cms-preset-features.ts"
import { disabledKVConfigModule, disabledRedisDriver, disabledUpstashDriver, hasRedisStore, hasUpstashStore, redisDriverSpecifier, upstashDriverSpecifier } from "./internal/kv-runtime.ts"
import { consoleDevAccessNotice } from "./console/dev-access-notice.ts"
import { createConsoleInvocationsIdentity } from "./console/internal.ts"
import { importOptionalOwner, isPackageInstalled, requireOptionalOwner, startPackageChecks } from "./internal/optional-owners.ts"
import { ownerModules } from "./internal/owner-modules.ts"
import { discoverConsoleBuildCatalog, type ConsoleBuildCatalog } from "./console/build.ts"
import { writeConsoleNitroPlugin, type ConsoleAccessBuild } from "./console/plugin.ts"
import { installConsoleProjectName, installConsoleSections } from "./console/runtime/server/sections.ts"
import { consoleOperationFeatures } from "./console/operation-features.ts"
import { resolveConsoleProjectNameFromRoot } from "./console/project.ts"
import { insertConsoleSection, resolveConsoleSectionIds, type ConsoleSectionId } from "./console/runtime/sections.ts"
import { consoleContributedSections, consoleDocumentEditorSectionIds, discoverConsoleEntrySections, isConsoleContributedSectionId } from "./console/contributions.ts"
import { addConsoleAppRoutes, addConsoleRpcHandler } from "./console/nitro.ts"
import { serializeConsoleRefresh } from "./console/refresh.ts"
import { assertConsoleAccess, assertConsoleProductionAuth, resolveConsoleOptions, consoleInvocationRootPlugin, createConsoleInvocationRootState, generatedConsolePluginRegistration, resolveConsoleAccessBuild, resolveGeneratedConsolePlugin, type ConsoleInvocationRootState, updateConsoleInvocationRootState } from "./console/vite.ts"

import type { BundleVitePlugin, NuxtPageLike } from "@vite-hub/bundle/vite"
import type { DatabaseNuxtIntegrationOptions } from "@vite-hub/database"
import type { CommentsVitePlugin } from "@vite-hub/comments/vite"
import type { EnvDeclarations } from "@vite-hub/env"
import type { resolveKVViteConfig } from "@vite-hub/kv/vite"
import type { HookHandler, Plugin, PluginOption, ResolvedConfig, UserConfig } from "vite"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import { resolveViteHubServerImports, type ServerAutoImport } from "./nuxt-server-imports.ts"

const databaseRuntimeState = ownModule(import.meta.url, "internal/database-runtime-state")
const doctorExtensionEntry = fileURLToPath(new URL("./doctor", import.meta.url))
const consoleRuntimeRoot = fileURLToPath(new URL("./console/runtime", import.meta.url))

type ViteHubNuxtOptions = Omit<ViteHubOptions, "database"> & {
  database?: boolean | Exclude<DatabaseNuxtIntegrationOptions, false>
}

/** True when the app names a Blob driver or stores, which works on hosts without a default Blob store. */
function explicitBlobOption(value: ViteHubOptions["blob"]): boolean {
  return Boolean(value && value !== true && ("driver" in value || "stores" in value))
}

function configuredProjectRoot(root: string, value: unknown): string | undefined {
  return value && typeof value === "object" && "projectRoot" in value && typeof value.projectRoot === "string"
    ? resolve(root, value.projectRoot)
    : undefined
}

function configuredProjectRootOption(value: unknown): string | undefined {
  return value && typeof value === "object" && "projectRoot" in value && typeof value.projectRoot === "string"
    ? value.projectRoot
    : undefined
}

/** The project's wrangler config, found and parsed the way Nitro's Cloudflare preset does. */
async function readProjectWranglerConfig(rootDir: string): Promise<Record<string, unknown> | undefined> {
  const configPath = await findNearestFile(["wrangler.json", "wrangler.jsonc", "wrangler.toml"], { startingFrom: rootDir }).catch(() => undefined)
  if (!configPath) return undefined
  const text = await readFile(configPath, "utf8")
  const extension = extname(configPath)
  const config: unknown = extension === ".toml" ? parseTOML(text) : extension === ".jsonc" ? parseJSONC(text) : JSON.parse(text)
  return isRecord(config) ? config : undefined
}

async function projectWranglerEnvAlias(rootDir: string): Promise<string | undefined> {
  const config = await readProjectWranglerConfig(rootDir)
  const alias = isRecord(config?.alias) ? config.alias["#vitehub/env/server"] : undefined
  return typeof alias === "string" ? alias : undefined
}

async function writeCloudflareAssetsMiddleware(projectRoot: string): Promise<string> {
  const file = join(projectRoot, ".vitehub/nitro/cloudflare-assets.mjs");
  await writeFileIfChanged(
    file,
    [
      'import { defineHandler } from "nitro"',
      "export default defineHandler(async event => {",
      "  const request = event.req",
      '  if (request.method !== "GET" && request.method !== "HEAD") return',
      "  const assets = request.runtime?.cloudflare?.env.ASSETS",
      "  if (!assets) return",
      "  const response = await assets.fetch(request)",
      "  if (response.status !== 404) return response",
      "})",
      "",
    ].join("\n"),
  );
  return file;
}

function configuredScanDirs(value: unknown): string[] | undefined {
  return value && typeof value === "object" && "scanDirs" in value && Array.isArray(value.scanDirs)
    ? value.scanDirs.filter((entry): entry is string => typeof entry === "string")
    : undefined
}

/**
 * Tell `vitehub` commands where `nuxt dev` listens: `.vitehub/dev-server.json` in the root, removed when Nuxt closes.
 * Nuxt runs Vite in middleware mode, so the Vite plugin cannot see the listener.
 */
function publishNuxtDevServer(nuxt: NuxtLike): void {
  const root = resolve(nuxt.options.rootDir || process.cwd())
  nuxt.hook?.("listen", (_server, listener) => {
    try {
      const url = new URL(listener.url)
      url.pathname = nuxt.options.app?.baseURL || "/"
      writeViteHubDevServerFile(root, { root, url: url.href })
    }
    catch {
      // A read-only root only means commands must pass --url.
    }
  })
  nuxt.hook?.("close", async () => {
    try {
      removeViteHubDevServerFile(root)
    }
    catch {
      // The file is advisory.
    }
  })
}

type NuxtLike = {
  /** The installed Nuxt version, such as `5.0.0-2611052317-a04317f`. */
  _version?: string
  callHook?: (name: "restart") => Promise<void>
  hook?: {
    (name: "pages:routerOptions", callback: (context: { files: Array<{ path: string, optional?: boolean }> }) => void): void
    (name: "app:templatesGenerated", callback: (app: {
      components: Array<{ pascalName: string, filePath: string }>
      layouts?: Record<string, { file: string }>
      pages?: NuxtPageLike[]
    }) => Promise<void> | void): void
    (name: "close" | "nitro:config", callback: ((config: Record<string, unknown>) => Promise<void>) | (() => Promise<void>)): void
    (name: "listen", callback: (server: unknown, listener: { url: string }) => void): void
    (name: "build:before" | "modules:done", callback: () => void): void
  }
  options: {
    _installedModules?: Array<{ meta: { name?: string } }>
    _layers?: NuxtServerDirOptions["_layers"]
    /** True for `nuxt prepare`, which loads Nuxt with `dev: false` and writes types without a build. */
    _prepare?: boolean
    alias?: Record<string, string>
    app?: {
      baseURL?: string
    }
    buildDir: string
    dev?: boolean
    experimental?: {
      nitroViteEnvironment?: boolean
    }
    devServerHandlers?: Array<{
      handler: (event: import("./console/runtime/server/request.ts").ConsoleRequestEvent) => void
      route?: string
    }>
    imports?: {
      imports?: Array<{ as?: string, from: string, name: string }>
    }
    modules?: unknown[]
    nitro?: Record<string, unknown>
    plugins?: Array<string | { src: string }>
    routeRules?: Record<string, {
      headers?: Record<string, string>
      [key: string]: unknown
    }>
    rootDir?: string
    router?: { options?: { sensitive?: boolean, strict?: boolean } }
    serverDir?: string
    srcDir?: string
    vite?: UserConfig
    vitehub?: ViteHubNuxtOptions
    vitehubCliDiscovery?: true
    watch?: string[]
    typescript?: Record<string, unknown>
  }
}

const agentVueComposables = ["useAgent", "useAgentInvocation", "useAgentInvocations", "useChat"]
const h3RuntimeRoot = dirname(fileURLToPath(import.meta.resolve("h3/package.json")))
const cloudflareTypes = fileURLToPath(new URL("./cloudflare-types.d.ts", import.meta.url))

function emailTemplateResolver(root: string): Plugin {
  const { resolveEmailTemplateModulePath } = requireOptionalOwner(ownerModules.emailVite, "email")
  return {
    name: "vite-hub/nuxt-email-templates",
    resolveId: id => resolveEmailTemplateModulePath(root, id),
  }
}

function installEmailTemplateResolver(config: Record<string, unknown>, root: string): void {
  const rollupConfig = (config.rollupConfig ??= {}) as Record<string, unknown>
  const plugins = (rollupConfig.plugins ??= []) as Plugin[]
  if (!plugins.some(plugin => plugin.name === "vite-hub/nuxt-email-templates")) {
    plugins.push(emailTemplateResolver(root))
  }
}

type RollupExternal = string | RegExp | ReadonlyArray<string | RegExp> | ((id: string, importer: string | undefined, isResolved: boolean) => boolean | null | undefined | void) | undefined

function isExternalId(external: RollupExternal, id: string, importer: string | undefined, isResolved: boolean): boolean {
  if (typeof external === "function") return Boolean(external(id, importer, isResolved))
  if (external === undefined) return false
  return [external].flat().some(entry => typeof entry === "string" ? entry === id : entry.test(id))
}

/**
 * `nuxt dev` with the Cloudflare preset runs the server on Node, where ViteHub aliases `cloudflare:workers` to a shim of
 * `env`. ViteHub's generated Nitro plugins list that scheme as external for the Worker build, and the bundler asks
 * `external` before it applies aliases, so the dev bundle would keep an import that Node cannot load.
 */
const nitroCloudflareWorkersDev = {
  name: "vite-hub/nitro-cloudflare-workers-dev",
  options(options: { external?: RollupExternal }) {
    const external = options.external
    return { ...options, external: (id: string, importer: string | undefined, isResolved: boolean) => id === "cloudflare:workers" ? false : isExternalId(external, id, importer, isResolved) }
  },
}

/**
 * Keep ViteHub's own `h3` imports on H3 2. Nuxt's Nitro v2 compatibility layer resolves `h3` to an H3 1 shim for
 * server code that it marks as legacy.
 */
function nitroViteHubH3(generatedRoots: string[]) {
  const roots = generatedRoots.map(root => `${root.replaceAll("\\", "/").replace(/\/+$/, "")}/`)
  const owners = new Map<string, boolean>()
  return {
    name: "vite-hub/nitro-h3",
    resolveId(id: string, importer?: string) {
      if (!/^h3(?:\/|$)/.test(id) || !importer) return
      const path = importer.split("?", 1)[0]!.replaceAll("\\", "/")
      if (!roots.some(root => path.startsWith(root))) {
        const directory = dirname(path)
        let owned = owners.get(directory)
        if (owned === undefined) {
          try {
            const manifest = findPackageJSON(pathToFileURL(path), import.meta.url)
            const pkg: unknown = manifest ? JSON.parse(readFileSync(manifest, "utf8")) : undefined
            // A ViteHub package that lists h3 only for development, such as the `@vite-hub/docs` Nuxt module, writes
            // its handlers for the host's Nitro through `#imports`, so they keep the host's H3.
            const hostH3 = isRecord(pkg) && isRecord(pkg.devDependencies) && "h3" in pkg.devDependencies && !(isRecord(pkg.dependencies) && "h3" in pkg.dependencies)
            owned = isRecord(pkg) && !hostH3 && (pkg.name === "vite-hub" || (typeof pkg.name === "string" && pkg.name.startsWith("@vite-hub/"))
              || (pkg.name === "nitro" && typeof pkg.version === "string" && pkg.version.startsWith("3."))
              || (pkg.name === "h3" && typeof pkg.version === "string" && pkg.version.startsWith("2.")))
          }
          catch { owned = false } // Virtual modules without a package retain the host's resolution.
          owners.set(directory, owned)
        }
        if (!owned) return
      }
      return fileURLToPath(import.meta.resolve(id))
    },
  }
}

/** Node development uses request bindings without importing the production Cloudflare runtime. */
async function writeCloudflareWorkersDevShim(buildDir: string): Promise<string> {
  const file = join(buildDir, "vitehub/cloudflare-workers.dev.mjs")
  await writeFileIfChanged(file, [
    "const bindings = () => globalThis.__env__ ?? process.env",
    "const read = key => bindings()[key] ?? process.env[key]",
    "export const env = new Proxy({}, {",
    "  get: (_, key) => read(key),",
    "  has: (_, key) => key in bindings() || key in process.env,",
    "  ownKeys: () => [...new Set([...Reflect.ownKeys(process.env), ...Reflect.ownKeys(bindings())])],",
    "  getOwnPropertyDescriptor(_, key) {",
    "    const descriptor = Object.getOwnPropertyDescriptor(bindings(), key) ?? Object.getOwnPropertyDescriptor(process.env, key)",
    "    return descriptor && { configurable: true, enumerable: descriptor.enumerable, writable: true, value: read(key) }",
    "  },",
    "})",
    "export async function waitUntil(promise) { if (globalThis.__wait_until__) return globalThis.__wait_until__(promise); await promise }",
    "export function withEnv() { throw new Error('cloudflare.withEnv is not available in Node development.') }",
    "class Unsupported { constructor() { throw new Error('This Cloudflare runtime class is not available in Node development.') } }",
    "export { Unsupported as DurableObject, Unsupported as RpcTarget, Unsupported as WorkerEntrypoint, Unsupported as WorkflowEntrypoint }",
    "",
  ].join("\n"))
  return file
}

function normalizeGeneratedNitroPlugins(config: Record<string, unknown>, root: string): void {
  if (!Array.isArray(config.plugins)) return
  config.plugins = config.plugins.map(plugin => typeof plugin === "string" && /^\.vitehub[\\/]/.test(plugin) && !isAbsolute(plugin) ? resolve(root, plugin) : plugin)
}

/** Put these plugins before Nitro's own resolvers, so they see generated and cache imports first. */
function installNitroBuildPlugins(config: Record<string, unknown>, generatedRoots: string[], dev = false, sections: readonly string[] = []): void {
  const rollupConfig = (config.rollupConfig ??= {}) as Record<string, unknown>
  const plugins = (rollupConfig.plugins ??= []) as Array<{ name?: string }>
  for (const plugin of [nitroCacheBypass(), nitroViteHubH3(generatedRoots), nitroOptionalPeers(config), consoleOperationFeatures(sections), ...dev ? [nitroCloudflareWorkersDev] : []]) {
    if (!plugins.some(candidate => candidate.name === plugin.name)) plugins.unshift(plugin)
  }
}

function pluginOptionHasName(option: PluginOption, name: string): boolean {
  if (Array.isArray(option)) return option.some(candidate => pluginOptionHasName(candidate, name))
  return Boolean(option && Reflect.get(Object(option), "name") === name)
}

const nitroRuntimeResolverNames = new Set([
  "@vite-hub/auth/vite",
  "@vite-hub/blob/vite",
  "@vite-hub/browser/vite",
  "@vite-hub/email/vite",
  "@vite-hub/kv/vite",
  "@vite-hub/markdown-template/vite",
  "@vite-hub/realtime/vite",
  "vite-hub/optional-owner-imports",
  "vite-hub/cloudflare-sh-syntax",
  // The durability boot plugin imports `#vitehub/durability/reporters`, which this plugin renders from the replayed plugins.
  "vite-hub/durability",
  "vite-hub/cloudflare-pkce-challenge",
  "vite-hub/unavailable-services",
])

const nitroConfigResolvedNames = new Set([
  ...nitroRuntimeResolverNames,
  "@vite-hub/content/vite",
  "@vite-hub/sandbox/task/vite",
])

function pluginResolveIdHandler(plugin: Plugin): HookHandler<NonNullable<Plugin["resolveId"]>> | undefined {
  if (typeof plugin.resolveId === "function") return plugin.resolveId
  return plugin.resolveId?.handler
}

function pluginLoadHandler(plugin: Plugin): HookHandler<NonNullable<Plugin["load"]>> | undefined {
  if (typeof plugin.load === "function") return plugin.load
  return plugin.load?.handler
}

function pluginConfigResolvedHandler(plugin: Plugin): HookHandler<NonNullable<Plugin["configResolved"]>> | undefined {
  if (typeof plugin.configResolved === "function") return plugin.configResolved
  return plugin.configResolved?.handler
}

function asReplayResolvedConfig(config: UserConfig): ResolvedConfig {
  // Vite normally converts alias records before configResolved. The separate Nitro build skips that step.
  if (config.resolve?.alias && !Array.isArray(config.resolve.alias)) {
    config.resolve.alias = Object.entries(config.resolve.alias).map(([find, replacement]) => ({ find, replacement }))
  }
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: Nitro replay has applied every Vite config hook and normalized the fields used by ViteHub runtime owners.
  return config as unknown as ResolvedConfig
}

async function finalizeNitroReplayPlugins(plugins: Plugin[], config: UserConfig): Promise<void> {
  // Nuxt can reuse its Vite build cache and only build Nitro. Resolve the Database owner first so consumers such as
  // KV can read its Definitions, layers, and contributions without waiting for Vite's configResolved or buildStart.
  const databaseOwners = plugins.filter(plugin => plugin.name === "@vite-hub/database/vite")
  const consumers = plugins.filter(plugin => nitroConfigResolvedNames.has(plugin.name))
  for (const plugin of [...databaseOwners, ...consumers]) {
    const configResolved = pluginConfigResolvedHandler(plugin)
    if (!configResolved) continue
    // SAFETY: Rollup supplies an opaque plugin context; the replayed hook does not read it.
    await configResolved.call({} as never, asReplayResolvedConfig(config))
  }
}

/** Keep the hook's filter, so the bundler skips the replayed hook for ids that the plugin does not own. */
function withHookFilter<Handler>(hook: unknown, handler: Handler): Handler | { filter: unknown, handler: Handler } {
  return isRecord(hook) && hook.filter !== undefined ? { filter: hook.filter, handler } : handler
}

function nitroRuntimeResolver(plugin: Plugin, config: Record<string, unknown>, agentOptions: { root: string, serverDirs?: string[] }): Plugin | undefined {
  const resolveId = nitroRuntimeResolverNames.has(plugin.name) ? pluginResolveIdHandler(plugin) : undefined
  const load = nitroRuntimeResolverNames.has(plugin.name) ? pluginLoadHandler(plugin) : undefined
  const transformWorkspaceAgent = (plugin as Plugin & {
    vitehub?: { agent?: { transformWorkspaceAgent?: (code: string, id: string, options: typeof agentOptions) => Promise<string | undefined> } }
  }).vitehub?.agent?.transformWorkspaceAgent
  if (!resolveId && !load && !transformWorkspaceAgent) return

  const replayResolveId: HookHandler<NonNullable<Plugin["resolveId"]>> | undefined = resolveId && function (id, importer, options) {
    // Nitro's development alias must reach its resolver instead of being externalized by a replayed hook.
    if (id === "cloudflare:workers" && isRecord(config.alias) && typeof config.alias[id] === "string") return
    // Nitro replays Vite hooks in a server build, but Rollup does not supply Vite's ssr flag.
    return resolveId.call(this, id, importer, { ...options, ssr: true })
  }
  const replayLoad: HookHandler<NonNullable<Plugin["load"]>> | undefined = load && function (id, options) {
    // All replayed loads run on Nitro's server, including Rollup calls without Vite options.
    return load.call(this, id, { ...options, ssr: true })
  }
  return {
    name: `vite-hub/nuxt-runtime-resolver:${plugin.name}`,
    // SAFETY: the filter comes from the same hook of the replayed plugin, so it has that hook's filter type.
    ...(replayResolveId ? { resolveId: withHookFilter(plugin.resolveId, replayResolveId) as Plugin["resolveId"] } : {}),
    ...(replayLoad ? { load: withHookFilter(plugin.load, replayLoad) as Plugin["load"] } : {}),
    ...(transformWorkspaceAgent ? {
      transform: {
        filter: { id: /\.[cm]?[jt]s(?:[?#]|$)/i },
        handler: (code: string, id: string) => transformWorkspaceAgent(code, id, agentOptions),
      },
    } : {}),
  }
}

function installNitroRuntimeResolvers(config: Record<string, unknown>, plugins: Plugin[], agentOptions: { root: string, serverDirs?: string[] }): void {
  const resolvers = plugins.map(plugin => nitroRuntimeResolver(plugin, config, agentOptions)).filter((plugin): plugin is Plugin => Boolean(plugin))
  if (!resolvers.length) return

  const rollupConfig = (config.rollupConfig ??= {}) as Record<string, unknown>
  const configuredPlugins = rollupConfig.plugins as PluginOption | undefined
  const nitroPlugins = Array.isArray(configuredPlugins)
    ? configuredPlugins
    : configuredPlugins
      ? [configuredPlugins]
      : []
  rollupConfig.plugins = nitroPlugins
  for (const resolver of resolvers) {
    if (!nitroPlugins.some(candidate => pluginOptionHasName(candidate, resolver.name))) nitroPlugins.push(resolver)
  }
}

function addTypeScriptDefaults(options: Record<string, unknown>, includes: string[], excludes: string[], key: "sharedTsConfig" | "tsConfig" = "tsConfig"): void {
  const typescript = (options.typescript ??= {}) as Record<string, unknown>
  const tsConfig = (typescript[key] ??= {}) as Record<string, unknown>
  tsConfig.include = [...new Set([...((tsConfig.include as string[] | undefined) ?? []), ...includes])]
  if (excludes.length > 0) {
    tsConfig.exclude = [...new Set([...((tsConfig.exclude as string[] | undefined) ?? []), ...excludes])]
  }
}

function configuredProjectRoots(options: ViteHubOptions, rootDir: string, viteRoot: string): string[] {
  return Object.entries(options)
    .filter((entry): entry is [string, { projectRoot: string }] => {
      const value = entry[1]
      return Boolean(value && typeof value === "object" && "projectRoot" in value && typeof value.projectRoot === "string")
    })
    .map(([name, value]) => resolve(name === "database" ? rootDir : viteRoot, value.projectRoot))
}

function addVueImports(nuxt: NuxtLike, from: string, names: string[]): void {
  nuxt.options.imports ??= {}
  const imports = (nuxt.options.imports.imports ??= [])
  for (const name of names) {
    const existing = imports.find(entry => (entry.as ?? entry.name) === name)
    if (existing && existing.from !== from) {
      throw viteHubErrorDiagnostics.VITE_HUB_B0008({ message: `[vitehub] Cannot auto-import ${name} from ${from} because it is already configured from ${existing.from}.` })
    }
    if (!existing) imports.push({ from, name })
  }
}

/**
 * Add ViteHub's server helpers to the auto-imports that Nuxt 5 gives to Nitro code. The app turns them off with
 * `nitro: { imports: false }`, which makes `imports` false here, or with `imports: { autoImport: false }`, which Nuxt
 * copies to `imports.autoImport`. A name that another source already configures keeps that source.
 */
function addNitroImports(config: Record<string, unknown>, entries: readonly ServerAutoImport[]): void {
  if (!isRecord(config.imports) || config.imports.autoImport === false) return
  const options = config.imports
  // SAFETY: Nitro's `imports.imports` is an unimport list of `{ name, as?, from }` entries.
  const imports = (Array.isArray(options.imports) ? options.imports : (options.imports = [])) as ServerAutoImport[]
  const taken = new Map<string, string>()
  for (const entry of imports) taken.set(entry.as ?? entry.name, entry.from)
  for (const preset of Array.isArray(options.presets) ? options.presets : []) {
    if (!isRecord(preset) || typeof preset.from !== "string" || !Array.isArray(preset.imports)) continue
    for (const item of preset.imports) {
      const name = typeof item === "string" ? item : isRecord(item) ? item.as ?? item.name : undefined
      if (typeof name === "string") taken.set(name, preset.from)
    }
  }
  for (const entry of entries) {
    if (taken.has(entry.name)) continue
    imports.push(entry)
    taken.set(entry.name, entry.from)
  }
}

interface NuxtConsoleInstallOptions {
  nuxt: NuxtLike
  projectRoot: string
  sections: readonly ConsoleSectionId[]
  /** Where Console discovery reads Agents, Schedules, Databases, and contributed sections. */
  discovery: Omit<Parameters<typeof discoverConsoleBuildCatalog>[0], "projectRoot" | "sections">
  /** Write the generated plugin at setup and on development changes. CLI discovery writes nothing. */
  writeGeneratedPlugin: boolean
  invocationRootState: ConsoleInvocationRootState
  /** Whether Nitro config is resolved, so discovery can read Database and contributed section definitions. */
  canDiscoverDefinitions: () => boolean
  access?: ConsoleAccessBuild
  /** Writes the generated Console Nitro plugin. The `nitro:config` hook writes it with the same writer. */
  writePlugin: (file: string, catalog: ConsoleBuildCatalog) => Promise<string>
}

async function installConsole({
  nuxt,
  projectRoot,
  sections,
  discovery,
  writeGeneratedPlugin,
  invocationRootState,
  canDiscoverDefinitions,
  access,
  writePlugin,
}: NuxtConsoleInstallOptions): Promise<string> {
  const { discoveryRoot, serverDirs } = discovery
  const plugin = resolveGeneratedConsolePlugin(projectRoot)
  installConsoleProjectName(projectRoot, resolveConsoleProjectNameFromRoot(projectRoot))
  if (nuxt.options.dev && nuxt.hook) {
    // Nuxt runs Nitro's app in a worker that never sees the client's address. The Nuxt process signs
    // loopback requests before Nitro forwards them.
    Reflect.apply(nuxt.hook, nuxt, ["nitro:init", (nitro: { options: { devHandlers: Array<{ handler?: unknown, route?: string }> } }) => {
      addViteHubDevPeerDevHandler(nitro.options.devHandlers)
    }])
    // WebSocket upgrades, such as Realtime rooms of the Console, skip Nitro's dev handlers. Sign them on the listener.
    Reflect.apply(nuxt.hook, nuxt, ["listen", (server: ViteHubDevPeerUpgradeServer & { address?: () => { address: string, port?: number } | string | null }) => {
      addViteHubDevPeerUpgradeSigner(server)
      const notice = consoleDevAccessNotice(access?.mode, server.address?.())
      if (notice) console[notice.level](notice.message)
    }])
  }
  const documentEditorSections = (await Promise.all(consoleDocumentEditorSectionIds.map(async (section) => {
    const entry = await consoleContributedSections.get(section)?.documents?.entry({ discoveryRoot, projectRoot, serverDirs })
    return entry ? [section] : []
  }))).flat()
  // Record table sections that an application module turns on, such as Comments with server/comments.ts.
  const entrySections = (await discoverConsoleEntrySections({ discoveryRoot, projectRoot, serverDirs })).filter(section => !sections.includes(section))
  installConsoleSections(projectRoot, [...sections, ...entrySections, ...documentEditorSections])
  const nitro = (nuxt.options.nitro ??= {}) as Parameters<typeof addConsoleAppRoutes>[0] & { plugins?: string[] }
  // Nitro adds its `baseURL`, which Nuxt sets to `app.baseURL`, to every route, asset, and route rule.
  addConsoleRpcHandler(nitro, consoleRuntimeRoot)
  addConsoleAppRoutes(nitro, consoleRuntimeRoot)
  const plugins = (nitro.plugins ??= []).filter(candidate => !generatedConsolePluginRegistration(candidate))
  nitro.plugins = plugins
  const refreshAgentDefinitions = serializeConsoleRefresh(async () => {
    const discoverySections = canDiscoverDefinitions()
      ? sections
      : sections.filter(section => section !== "databases" && !isConsoleContributedSectionId(section))
    const catalog = await discoverConsoleBuildCatalog({ ...discovery, projectRoot, sections: discoverySections })
    const identity = await writePlugin(plugin, catalog)
    updateConsoleInvocationRootState(invocationRootState, projectRoot, identity)
  })
  if (writeGeneratedPlugin) await refreshAgentDefinitions()
  if (nuxt.options.dev && writeGeneratedPlugin) {
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Nuxt exposes hook overloads, while this structural seam keeps narrow test hosts assignable.
    // SAFETY: Nuxt's hook overload includes builder:watch with this callback contract.
    const hookBuilderWatch = nuxt.hook as unknown as ((name: "builder:watch", callback: (event: string, path: string) => Promise<void>) => void) | undefined
    hookBuilderWatch?.("builder:watch", async (_event, _path) => {
      await refreshAgentDefinitions()
    })
  }
  if (!plugins.includes(plugin)) plugins.push(plugin)
  return plugin
}

type QueueNitroConfigHandler = (options: {
  development?: boolean
  nitro: Record<string, unknown>
  projectRoot: string
  root: string
  serverDirs?: string[]
  viteConfig?: UserConfig
}) => Promise<Record<string, unknown>>

type WorkflowNitroConfigHandler = (options: {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}) => Promise<Record<string, unknown>>

type WorkflowRegistryTransform = (code: string, id: string) => string | Promise<string>

function agentWorkflowRegistryTransform(plugin: Plugin): WorkflowRegistryTransform | undefined {
  return (plugin as Plugin & {
    vitehub?: { agent?: { transformWorkflowRegistry?: (code: string, id: string) => string | Promise<string> } }
  }).vitehub?.agent?.transformWorkflowRegistry
}

function flattenPlugins(options: readonly unknown[]): Plugin[] {
  const plugins: Plugin[] = []
  for (const option of options) {
    if (Array.isArray(option)) plugins.push(...flattenPlugins(option))
    else if (option && typeof option === "object" && "name" in option) plugins.push(option as Plugin)
  }
  return plugins
}

function filterPluginOptions(
  options: readonly unknown[],
  keep: (plugin: Plugin) => boolean,
): unknown[] {
  return options.flatMap((option) => {
    if (Array.isArray(option)) {
      const nested = filterPluginOptions(option, keep)
      return nested.length > 0 ? [nested] : []
    }
    const plugin = flattenPlugins([option])[0]
    if (plugin && !keep(plugin)) return []
    return [option]
  })
}

function configHandler(plugin: Plugin) {
  if (typeof plugin.config === "function") return plugin.config
  return plugin.config?.handler
}

function queueNitroConfigHandler(plugin: Plugin): QueueNitroConfigHandler | undefined {
  return (plugin as Plugin & {
    vitehub?: {
      queue?: {
        createNitroConfig?: QueueNitroConfigHandler
      }
    }
  }).vitehub?.queue?.createNitroConfig
}

function workflowNitroConfigHandler(plugin: Plugin): WorkflowNitroConfigHandler | undefined {
  return (plugin as Plugin & {
    vitehub?: {
      workflow?: {
        createNitroConfig?: WorkflowNitroConfigHandler
      }
    }
  }).vitehub?.workflow?.createNitroConfig
}

function deploymentOutputEnvPluginHandler(plugin: Plugin): ((envPlugin: Plugin) => void) | undefined {
  return (plugin as Plugin & {
    vitehub?: {
      deploymentOutput?: {
        useEnvPlugin?: (envPlugin: Plugin) => void
      }
    }
  }).vitehub?.deploymentOutput?.useEnvPlugin
}

type VitePluginNitroModule = {
  name?: string
  setup: (nitro: unknown) => void | Promise<void>
}

function vitePluginNitroModule(plugin: Plugin): VitePluginNitroModule | undefined {
  const nitro = (plugin as Plugin & { nitro?: VitePluginNitroModule }).nitro
  return nitro && typeof nitro.setup === "function" ? nitro : undefined
}

function installVitePluginNitroModules(config: Record<string, unknown>, plugins: Plugin[]): void {
  const configured = config.modules
  const modules = Array.isArray(configured) ? configured : configured ? [configured] : []
  config.modules = modules
  for (const plugin of plugins) {
    const nitroModule = vitePluginNitroModule(plugin)
    if (!nitroModule) continue
    if (!modules.some((candidate) => {
      if (candidate === nitroModule) return true
      return Boolean(nitroModule.name && candidate && typeof candidate === "object" && Reflect.get(candidate, "name") === nitroModule.name)
    })) modules.push(nitroModule)
  }
}

function withoutDeploymentOutput(options: readonly unknown[]): unknown[] {
  return options.flatMap((option) => {
    if (Array.isArray(option)) return [withoutDeploymentOutput(option)]
    if (option && typeof option === "object" && "name" in option && option.name === "vite-hub/deployment-output") {
      return []
    }
    return [option]
  })
}

/** Vite config hooks can replace an explicit `noExternals` boolean with a package list. Keep the boolean. */
function restoreNoExternals(config: Record<string, unknown>, incomingNoExternals: boolean | undefined): void {
  if (incomingNoExternals !== undefined) config.noExternals = incomingNoExternals
}

/**
 * A workspace links ViteHub packages from their source folders, so their real paths do not contain `@vite-hub/`.
 * Nitro loads such a package from Node, which cannot read the generated aliases.
 */
function linkedViteHubPackageRoots(projectRoot: string): string[] {
  const nodeModules = join(projectRoot, "node_modules")
  const scope = join(nodeModules, "@vite-hub")
  const links = [join(nodeModules, "vite-hub"), ...(existsSync(scope) ? readdirSync(scope).map(name => join(scope, name)) : [])]
  return links.filter(existsSync).map(link => realpathSync(link)).filter(root => !root.split(sep).includes("node_modules"))
}

/** Add packages that Nitro must bundle, unless Nitro already bundles every package. */
function addNoExternals(config: Record<string, unknown>, entries: string[]): void {
  if (config.noExternals === true) return
  const current: unknown[] = Array.isArray(config.noExternals) ? config.noExternals : []
  config.noExternals = [...new Set([...current, ...entries])]
}

async function applyNitroConfig(
  plugins: Plugin[],
  nitroConfig: Record<string, unknown>,
  nuxt: NuxtLike,
  projectRoot: string,
) {
  const incomingNoExternals = typeof nitroConfig.noExternals === "boolean" ? nitroConfig.noExternals : undefined
  const environment = {
    command: nuxt.options.dev ? "serve" : "build",
    isPreview: false,
    isSsrBuild: true,
    mode: nuxt.options.vite?.mode ?? (nuxt.options.dev ? "development" : "production"),
  } as const
  const serverDirs = resolveNuxtServerDirs(nuxt.options)
  const generatedRoot = join(nuxt.options.buildDir, "vitehub")
  let config = mergeConfig({
    plugins,
    resolve: {
      alias: nuxt.options.alias,
    },
    root: nuxt.options.rootDir || process.cwd(),
  }, nuxt.options.vite ?? {}) as UserConfig & {
    [VITEHUB_GENERATED_ROOT]?: string
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: true
    [VITEHUB_PREPARE]?: true
    [VITEHUB_PROJECT_ROOT]?: string
    [VITEHUB_SERVER_DIRS]?: string[]
    [VITEHUB_APP_BASE_URL]?: string
    nitro?: Record<string, unknown>
    vitehubCliDiscovery?: true
  }
  config.root = resolve(nuxt.options.rootDir || process.cwd(), config.root || ".")
  // Filter command-only plugins from both lists without re-evaluating Vite's functional `apply` selection.
  const applies = (plugin: Plugin) => typeof plugin.apply !== "string" || plugin.apply === environment.command
  plugins = plugins.filter(applies)
  config.plugins = filterPluginOptions(config.plugins ?? [], applies) as PluginOption[]
  const restoreReplayOwnership = () => {
    config[VITEHUB_GENERATED_ROOT] = generatedRoot
    config[VITEHUB_NITRO_CONFIG_CONTEXT] = true
    config[VITEHUB_PROJECT_ROOT] = projectRoot
    config[VITEHUB_APP_BASE_URL] = nuxt.options.app?.baseURL || "/"
    if (serverDirs) config[VITEHUB_SERVER_DIRS] = serverDirs
    // `nuxt prepare` replays the hooks as a build so the types match it, but it builds nothing.
    if (nuxt.options._prepare) config[VITEHUB_PREPARE] = true
    // A CLI command loads the project while its dev server may run. Plugins that see the flag do not rewrite the
    // generated files that the dev server watches, as they do when the CLI resolves a plain Vite config.
    if (nuxt.options.vitehubCliDiscovery) config.vitehubCliDiscovery = true
  }
  restoreReplayOwnership()
  config.build ??= {}
  config.nitro = nitroConfig
  config.server ??= {}
  const transformWorkflowRegistry = plugins.map(agentWorkflowRegistryTransform).find(Boolean)

  const orderedPlugins = [...plugins].sort((left, right) => {
    const order = (plugin: Plugin): number => plugin.name === "vite-hub/deployment-output"
      ? 2
      : plugin.enforce === "pre" ? -1 : plugin.enforce === "post" ? 1 : 0
    return order(left) - order(right)
  })
  let replayedDatabaseDiscoveryRoot: string | undefined
  let hasReplayedDatabaseDiscoveryRoot = false
  for (const plugin of orderedPlugins) {
    const handler = configHandler(plugin)
    if (handler) {
      const previousDatabaseProjectRoot = configuredProjectRootOption(getResolvedFeatureOptions(config, "database"))
      const result = await handler.call({} as never, config, environment)
      // The Database options that this hook returned, before Vite merges them into the earlier ones.
      const returnedDatabase = result ? getResolvedFeatureOptions(result, "database") : undefined
      if (result) {
        // SAFETY: Vite config hooks return Vite's UserConfig shape extended by Nitro's `nitro` key.
        const { nitro, ...viteConfig } = result as UserConfig & { nitro?: Record<string, unknown> }
        config = mergeConfig(config, viteConfig)
        // SAFETY: The ViteHub replay boundary accepts Nitro's open configuration object under the `nitro` key.
        if (nitro) config.nitro = nitro as Record<string, unknown>
      }
      if (plugin.name !== "@vite-hub/database/vite") {
        const database = getResolvedFeatureOptions(config, "database")
        if (returnedDatabase !== undefined || configuredProjectRootOption(database) !== previousDatabaseProjectRoot) {
          hasReplayedDatabaseDiscoveryRoot = true
          replayedDatabaseDiscoveryRoot = configuredProjectRoot(config.root || projectRoot, returnedDatabase ?? database)
        }
      }
      restoreReplayOwnership()
    }

    const createQueueNitroConfig = queueNitroConfigHandler(plugin)
    if (createQueueNitroConfig) {
      const projectRoot = nuxt.options.rootDir || process.cwd()
      config.nitro = await createQueueNitroConfig({
        development: nuxt.options.dev,
        nitro: config.nitro || {},
        projectRoot,
        root: projectRoot,
        serverDirs: resolveNuxtServerDirs(nuxt.options),
        // The replayed config holds the Cloudflare provider output that the deployment output plugin composes last.
        viteConfig: config,
      })
    }

    const createWorkflowNitroConfig = workflowNitroConfigHandler(plugin)
    if (createWorkflowNitroConfig) {
      const projectRoot = nuxt.options.rootDir || process.cwd()
      config.nitro = await createWorkflowNitroConfig({
        nitro: config.nitro || {},
        projectRoot,
        serverDirs: resolveNuxtServerDirs(nuxt.options),
        transformRegistry: transformWorkflowRegistry,
      })
    }
  }

  await finalizeNitroReplayPlugins(plugins, config)

  if (config.nitro) {
    installVitePluginNitroModules(config.nitro, plugins)
    Object.assign(nitroConfig, config.nitro)
    restoreNoExternals(nitroConfig, incomingNoExternals)
    config.nitro = nitroConfig
  }
  return { config, hasReplayedDatabaseDiscoveryRoot, replayedDatabaseDiscoveryRoot }
}

function resolvedKVFromPlugin(plugin: Plugin | undefined, configured: ViteHubOptions["kv"]): ReturnType<typeof resolveKVViteConfig>["kv"] {
  const candidate: unknown = plugin
  // SAFETY: The canonical KV plugin name identifies the framework-owned configuration API.
  const kvPlugin = candidate as (Plugin & {
    api?: { getConfig?: () => ReturnType<typeof resolveKVViteConfig> }
  }) | undefined
  if (kvPlugin?.api?.getConfig) return kvPlugin.api.getConfig().kv
  return configured ? requireOptionalOwner(ownerModules.kvVite, "kv").resolveKVViteConfig(configured === true ? undefined : configured).kv : false
}

/** Matches Nuxt's `NuxtModule` contract, so `modules: [viteHubNuxt]` type-checks. */
type ViteHubNuxtModule = {
  (inlineOptions: Partial<ViteHubNuxtOptions> | undefined, nuxt?: unknown): Promise<void>
  getModuleDependencies: () => Promise<Record<string, { optional: boolean; defaults: Record<string, unknown> }>>
  getMeta: () => Promise<{
    compatibility: { server: "nitro3" }
    configKey: "vitehub"
    name: "vite-hub/nuxt"
  }>
}

/**
 * An app that imports `vite-hub/ui` parts gets their runtime without adding `@vite-hub/ui/nuxt`: the plugin that gives
 * them Nuxt UI's Nuxt icon, their icons in the `@nuxt/icon` client bundle, and component auto-imports. `@vite-hub/ui` owns all three. Headless apps
 * do not need the optional Nuxt UI peer or its module, so they must not receive a plugin that imports it.
 */
async function installViteHubUIRuntime(nuxt: NuxtLike): Promise<void> {
  if (!nuxt.hook || !isPackageInstalled("@nuxt/ui")) return
  const ui = await importOptionalOwner("@vite-hub/ui", () => import("@vite-hub/ui/nuxt"))
  if (!ui) return
  const hook = nuxt.hook
  nuxt.hook("modules:done", () => {
    // The package can be present for the Console alone. Only Nuxt UI's module generates its component themes.
    // Wait until every module has installed, including modules that enable Nuxt UI after vite-hub/nuxt.
    if (!nuxt.options._installedModules?.some(({ meta }) => meta.name === "@nuxt/ui")) return
    ui.addViteHubUIRuntime({
      hook: (name, callback) => Reflect.apply(hook, nuxt, [name, callback]),
      options: { plugins: (nuxt.options.plugins ??= []) },
    })
    // Auto-import the components, as the UI module did. The app still imports `@vite-hub/ui/styles.css` itself.
    ui.addViteHubUIComponents(nuxt)
  })
}

/**
 * Stop before any setup on Nuxt 4 or older. They run Nitro 2 and H3 1, which ViteHub does not support, and a build
 * there would fail later with errors that do not name the cause.
 */
function assertSupportedNuxt(version: string | undefined): void {
  const major = version === undefined ? Number.NaN : Number.parseInt(version, 10)
  if (!(major < 5)) return
  throw viteHubErrorDiagnostics.VITE_HUB_B0023({
    message: `[vitehub] vite-hub/nuxt needs Nuxt 5, which runs Nitro 3 and H3 2. This app runs Nuxt ${version}. Until Nuxt 5 is stable, install the nightly release: pnpm add nuxt@npm:nuxt-nightly@5x`,
  })
}

const viteHubNuxtModule: ViteHubNuxtModule = async function viteHubNuxtModule(inlineOptions, nuxtInstance): Promise<void> {
  if (!nuxtInstance) return
  // SAFETY: Nuxt supplies this module callback with its instance; NuxtLike describes only the members this integration uses.
  const nuxt = nuxtInstance as NuxtLike
  assertSupportedNuxt(nuxt._version)
  // Nuxt does not run the Vite Doctor plugin, so `vite-doctor/nuxt` receives the extension through its hook.
  if (nuxt.hook) {
    Reflect.apply(nuxt.hook, nuxt, ["doctor:extendExtensions", (entries: string[]) => {
      entries.push(doctorExtensionEntry)
    }])
  }

  await installViteHubUIRuntime(nuxt)

  const configuredModuleOptions = {
    ...nuxt.options.vitehub,
    ...inlineOptions,
  } as ViteHubNuxtOptions
  const moduleOptions = { ...configuredModuleOptions, preset: configuredModuleOptions.preset ?? detectPreset() ?? "node" }
  const rootDir = nuxt.options.rootDir || process.cwd()
  const projectRoot = resolveViteHubProjectRoot(rootDir)
  // The `cms` preset turns on Workspace, Database, and Blob. Nuxt knows the root here, so resolve it once.
  const options = markCmsPresetFeaturesResolved(withConnectionsDatabase(withDataDir(resolveCmsPresetFeatures(withComments({
    ...moduleOptions,
    // `vitehub()` reads `false` as "off" and unset as "development operation RPC only".
    console: moduleOptions.console === false ? false : resolveConsoleOptions(moduleOptions.console),
  } as ViteHubOptions), { projectRoot, serverDirs: resolveNuxtServerDirs(nuxt.options) }))))
  const consoleOptions = resolveConsoleOptions(options.console)
  const plan = resolveDeploymentPlan(moduleOptions.preset)
  // Explicit Database roots are relative to Nuxt's rootDir; automatic discovery uses the ViteHub project root.
  const journalDatabaseRoot = options.database && options.database !== true && options.database.projectRoot !== undefined
    ? rootDir
    : projectRoot
  const agentJournal = options.agent && options.agent !== true ? options.agent.invocations : undefined
  /**
   * In Nuxt, an explicit Database root is relative to rootDir, and replayed Vite plugins can change the Database.
   * A production build resolves the D1 binding of the default journal here and hands it to the Agent Invocations Vite
   * plugin, so the plugin writes the same binding when the Vite build runs its config hook again.
   */
  const writeNuxtAgentJournal = async (database: typeof options.database, databaseRoot: string) => {
    if (!options.agent || nuxt.options.dev || nuxt.options.vitehubCliDiscovery || !isDefaultAgentJournal(agentJournal)) return
    // An explicit `databaseUrl` keeps libSQL.
    const d1Binding = agentJournal?.databaseUrl ? undefined : defaultDatabaseD1Binding(plan.preset, database, { root: databaseRoot, serverDirs: resolveNuxtServerDirs(nuxt.options) })
    assertAgentInvocationsRetention(agentJournal?.retention, d1Binding !== undefined, agentJournal?.databaseUrl)
    if (!nuxt.options._prepare) assertAgentInvocationsUrl(plan.preset, agentJournal?.databaseUrl)
    ;(nuxt.options.vite as Record<string, unknown>)[VITEHUB_AGENT_JOURNAL_D1] = { binding: d1Binding }
    const libsql = defaultJournalNeedsLibsql({ build: true, databaseUrl: agentJournal?.databaseUrl, preset: plan.preset })
    await writeAgentInvocationsNitroPlugin({ database: Boolean(options.database), d1Binding, default: agentJournal, libsql, projectRoot })
  }
  await writeNuxtAgentJournal(options.database, journalDatabaseRoot)
  const nitro = (nuxt.options.nitro ??= {})
  const nitroPreset = plan.preset === "deno" ? "deno-server" : plan.nitroPreset
  if (typeof nitro.preset === "string" && normalizeNitroPreset(nitro.preset) !== nitroPreset) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0009({ message: "[vitehub] vitehub preset " + JSON.stringify(plan.preset) + " conflicts with nitro.preset " + JSON.stringify(nitro.preset) + "." })
  }
  nitro.preset = nitroPreset
  if (options.realtime) {
    const features = (nitro.features ??= {}) as Record<string, unknown>
    features.websocket = true
  }
  if (plan.preset === "cloudflare") {
    const cloudflare = (nitro.cloudflare ??= {}) as Record<string, unknown>;
    cloudflare.deployConfig ??= true;
    const wasm = (nitro.wasm ??= {}) as Record<string, unknown>;
    wasm.lazy ??= true;
    if (!nuxt.options.dev)
      nitro.exportConditions = cloudflareExportConditions(nitro.exportConditions);
    if (!nuxt.options.dev) {
      if (nuxt.hook)
        Reflect.apply(nuxt.hook, nuxt, [
          "nitro:init",
          (instance: {
            options: {
              dev?: boolean;
              output: { serverDir: string };
            };
            hooks: { hook: (name: string, callback: () => Promise<void>) => void };
          }) => {
            instance.hooks.hook("compiled", async () => {
              if (instance.options.dev) return;
              const config = await findNearestFile(
                ["wrangler.json", "wrangler.jsonc", "wrangler.toml"],
                { startingFrom: rootDir },
              ).catch(() => undefined);
              if (!config) return;
              const generated = join(instance.options.output.serverDir, "wrangler.json");
              if (!existsSync(generated)) return;
              const redirect = join(dirname(config), ".wrangler/deploy/config.json");
              await mkdir(dirname(redirect), { recursive: true });
              await writeFile(
                redirect,
                `${JSON.stringify({ configPath: relative(dirname(redirect), generated) })}\n`,
              );
            });
          },
        ]);
    }
    // Nitro 3 resolves the Cloudflare preset to `cloudflare-dev` in development, which runs the server in workerd.
    // ViteHub's Cloudflare development shims bindings on Node, so keep Nitro's Node runner unless the app picks one.
    if (nuxt.options.dev) {
      const devServer = (nitro.devServer ??= {}) as Record<string, unknown>
      // Copy the environment choice before Nitro's preset can fill in its own runner default.
      devServer.runner ??= process.env.NITRO_DEV_RUNNER || "node-worker"
    }
  }
  nuxt.options.vite ??= {}
  nuxt.options.vite.root ??= rootDir
  const viteRoot = resolve(rootDir, typeof nuxt.options.vite?.root === "string" ? nuxt.options.vite.root : rootDir)
  const configuredDatabaseDiscoveryRoot = configuredProjectRoot(rootDir, options.database)
  const effectiveBlob = consoleOptions ? options.blob : false
  const explicitBlob = explicitBlobOption(effectiveBlob)
  const consoleBlobEnabled = Boolean(effectiveBlob) && (plan.services.blob.supported || explicitBlob)
  const resolvedConsoleBlob = consoleBlobEnabled
    ? requireOptionalOwner(ownerModules.blobVite, "blob").resolveBlobViteConfig(effectiveBlob === true ? undefined : effectiveBlob, { hosting: plan.nitroPreset }).blob
    : false
  const consoleBlobStores = resolvedConsoleBlob
    ? Object.keys(resolvedConsoleBlob.stores || { default: resolvedConsoleBlob.store })
    : []
  const effectiveKV = options.kv
  const effectiveQueue = options.queue
  const consoleSections = resolveConsoleSectionIds({
    ...options,
    env: options.env !== false,
    blob: consoleBlobEnabled,
    kv: effectiveKV,
    preset: plan.preset,
    queue: effectiveQueue,
    sandboxTask: options.sandboxTask === true && plan.services.sandbox.supported,
  })
  if (nuxt.options.dev) consoleSections.splice(0, consoleSections.length, ...insertConsoleSection(consoleSections, "setup"))
  const runtimeCapabilityImports = {
    blob: consoleBlobEnabled ? "vite-hub/blob" : false,
    connections: options.connections ? generatedModules.connectionsAgent : false,
    console: consoleOptions ? "vite-hub/console/server" : false,
    db: options.database ? "vite-hub/database/drizzle" : false,
    i18n: options.i18n ? "vite-hub/i18n/server" : false,
    // Email and KV capabilities exist only when the app installed their packages.
    ...ownerModules.emailVite ? { email: "vite-hub/email/server" } : {},
    ...ownerModules.kvVite ? { kv: "vite-hub/kv" } : {},
  } satisfies Record<string, false | string>
  const consoleInvocationRootState = createConsoleInvocationRootState()
  const consoleInvokeEnabled = consoleOptions ? consoleOptions.invoke ?? Boolean(nuxt.options.dev) : false
  let generatedConsolePluginPath: string | undefined
  let consoleWorkflowConfigResolved = false
  const effectiveAuth = options.auth
  // Every enabled feature adds its server helpers to Nitro auto-imports. The table is in `nuxt-server-imports.ts`.
  const serverAutoImports = resolveViteHubServerImports({
    ...options,
    auth: effectiveAuth,
    blob: options.blob && (plan.services.blob.supported || explicitBlobOption(options.blob)),
    env: options.env !== false,
    kv: effectiveKV,
    queue: effectiveQueue && plan.services.queue.supported,
    sandboxTask: options.sandboxTask === true && plan.services.sandbox.supported,
    // Match the Workflow owner's implicit enablement through Agent, including the Netlify exception.
    workflow: options.workflow !== false && Boolean(options.workflow || (options.agent && plan.preset !== "netlify")),
  })
  let consoleHasPrimaryAuth = false;
  let consoleAccess: ConsoleAccessBuild | undefined
  if (consoleOptions) {
    const configuredConsole = resolveConsoleOptions(consoleOptions)
    if (!configuredConsole) throw new TypeError("[vitehub] Invalid console configuration")
    if (!nuxt.options.vitehubCliDiscovery) {
      const appAuth = effectiveAuth
        ? requireOptionalOwner(ownerModules.authVite, "auth").resolveAuthViteConfig(effectiveAuth === true ? undefined : effectiveAuth, viteRoot, { serverDirs: resolveNuxtServerDirs(nuxt.options) })
        : undefined;
      consoleHasPrimaryAuth = Boolean(appAuth);
      const authIndex = consoleSections.indexOf("auth");
      if (!appAuth && authIndex !== -1) consoleSections.splice(authIndex, 1);
      if (appAuth && authIndex === -1) consoleSections.push("auth");
      assertConsoleAccess(configuredConsole, { auth: appAuth })
      // `console.authorize` is a path in nuxt.config.ts, so it resolves from rootDir, not from the Vite root (srcDir).
      consoleAccess = resolveConsoleAccessBuild(configuredConsole, { root: rootDir })
      if (!nuxt.options.dev && !nuxt.options._prepare) assertConsoleProductionAuth(configuredConsole)
    }
  }
  // Module setup and the `nitro:config` hook write the same Console plugin. Only the file and the catalog differ.
  const writeNuxtConsolePlugin = (file: string, catalog: ConsoleBuildCatalog) => writeConsoleNitroPlugin({
    file,
    projectRoot,
    sections: consoleSections,
    catalog,
    blobStores: consoleBlobStores,
    invoke: consoleInvokeEnabled,
    active: () => !consoleInvocationRootState.closed,
    access: consoleAccess,
    runtimeCapabilityImports,
    development: nuxt.options.dev === true,
    pageTool: { base: nuxt.options.app?.baseURL || "/" },
  })
  const viteConfig = nuxt.options.vite as UserConfig & {
    [VITEHUB_GENERATED_ROOT]?: string
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: true
    [VITEHUB_PREPARE]?: true
    [VITEHUB_PROJECT_ROOT]?: string
    [VITEHUB_SERVER_DIRS]?: string[]
    [VITEHUB_APP_BASE_URL]?: string
  }
  const secondaryProjectRoots = [...new Set([
    ...configuredProjectRoots(options, rootDir, viteRoot),
    ...(options.connections ? [viteRoot] : []),
  ])].filter(root => root !== projectRoot)
  const generatedTypes = [
    relative(nuxt.options.buildDir, join(projectRoot, ".vitehub/types.d.ts")),
    ...(effectiveQueue ? [relative(nuxt.options.buildDir, join(projectRoot, ".vitehub/queue.d.ts"))] : []),
    ...secondaryProjectRoots
      .map(root => relative(nuxt.options.buildDir, join(root, ".vitehub/**/*.d.ts"))),
  ]
  const generatedData = secondaryProjectRoots
    .map(root => relative(nuxt.options.buildDir, join(root, ".vitehub/data/**/*.d.ts")))
  // `@cloudflare/workers-types` is an optional peer. `cloudflare-types.d.ts` references it, so add that file only when the app installs it.
  if (plan.preset === "cloudflare" && isPackageInstalled("@cloudflare/workers-types")) generatedTypes.push(relative(nuxt.options.buildDir, cloudflareTypes))
  addTypeScriptDefaults(nuxt.options, generatedTypes, generatedData)
  // Code under shared/ can type-import server files, such as server/auth.ts, which use the generated declarations.
  addTypeScriptDefaults(nuxt.options, generatedTypes, generatedData, "sharedTsConfig")
  addTypeScriptDefaults((nuxt.options.nitro ??= {}), generatedTypes, generatedData)
  if (options.database) {
    const databaseOptions = options.database === true ? {} : { ...options.database }
    // Cloudflare SQLite Definitions default to D1 unless a driver is explicit.
    const defaultD1 = plan.preset === "cloudflare" && !("driver" in databaseOptions) && !usesOnlyPostgresDatabases(
      resolveViteHubProjectRoot(rootDir, { projectRoot: databaseOptions.projectRoot }),
      databaseOptions.projectRoot === undefined && nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
    )
    const { hubDb: hubDatabaseNuxt } = requireOptionalOwner(await importOptionalOwner("@vite-hub/database", () => import("@vite-hub/database/nuxt")), options.connections ? "connections" : "database")
    await hubDatabaseNuxt(defaultD1 ? { driver: "d1", ...databaseOptions } : databaseOptions)(undefined, nuxt)
  }

  const installedPlugins = flattenPlugins(viteHubPlugins(markCmsPresetFeaturesResolved({
    ...options,
    ...(effectiveKV !== undefined ? { kv: effectiveKV } : {}),
  } as ViteHubOptions)))
    // Nuxt runs its own Nitro.
    .filter(plugin => !isIncludedNitroPlugin(plugin))
    .filter(plugin => !(options.database && plugin.name === "@vite-hub/database/vite"))
    .filter(plugin => !consoleOptions || !["vite-hub/console", "vite-hub/console-invocation-root"].includes(plugin.name))
  const plugins = [
    ...installedPlugins.filter(plugin => plugin.name !== "vite-hub/deployment-output"),
    ...(nuxt.options.vitehubCliDiscovery ? [{
      name: "vite-hub/deployment-inspect",
      vitehub: {
        inspect: () => {
          // SAFETY: Nuxt's Nitro options use the public rootDir and output.dir configuration contract.
          const nitro = nuxt.options.nitro as { rootDir?: string, output?: { dir?: string } } | undefined
          return { providerOutput: describeDeploymentPlanOutput(plan, resolve(nitro?.rootDir ?? rootDir), nitro?.output?.dir) }
        },
      },
    }] : []),
    ...(consoleOptions && options.agent ? [consoleInvocationRootPlugin(
      projectRoot,
      createConsoleInvocationsIdentity(projectRoot),
      consoleInvocationRootState,
    )] : []),
  ]
  const existing = withoutDeploymentOutput(
    Array.isArray(nuxt.options.vite?.plugins) ? nuxt.options.vite.plugins : [],
  )
  const existingPluginsByName = new Map(
    flattenPlugins(existing)
      .filter(plugin => plugin.name)
      .map(plugin => [plugin.name, plugin]),
  )
  const replayPlugins = [
    ...installedPlugins.map(plugin => existingPluginsByName.get(plugin.name) || plugin),
    ...flattenPlugins(existing).filter(plugin =>
      (plugin.name.startsWith("@vite-hub/") || plugin.name.startsWith("vite-hub/"))
      && !plugins.some(candidate => candidate.name === plugin.name),
    ),
  ]
  // Nuxt runs separate Vite builds and then Nitro; all phases belong to this build command.
  const bundlePlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/bundle/vite") as BundleVitePlugin | undefined
  if (bundlePlugin && !nuxt.options.dev) {
    nuxt.hook?.("build:before", () => { bundlePlugin.api.startBuild() })
    let routerOptions: { files: Array<{ path: string, optional?: boolean }> } | undefined
    // Keep the context so files added by later hooks are also visible after templates are generated.
    nuxt.hook?.("pages:routerOptions", (context) => { routerOptions = context })
    // Nuxt resolves pages and layouts before the client build, so the client report can say what each route loads.
    nuxt.hook?.("app:templatesGenerated", (app) => {
      const customOptions = routerOptions?.files.find(file => !file.optional)
      const layoutComponent = app.components.find(component => component.pascalName === "NuxtLayout")?.filePath
      bundlePlugin.api.setRoutes(customOptions ? [] : nuxtPageRoutes(app.pages ?? [], layoutComponent ? app.layouts : {}, layoutComponent), {
        sensitive: nuxt.options.router?.options?.sensitive ?? true,
        strict: nuxt.options.router?.options?.strict ?? false,
        ...(customOptions ? { unavailable: `Custom router options (${customOptions.path}) can change routes or matching at runtime.` } : {}),
      })
    })
  }
  // Nuxt rewrites production component names using its resolved registry, including directory prefixes and modes.
  // SAFETY: The plugin name identifies the Comments plugin and its public component registry API.
  const commentsPlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/comments/vite") as CommentsVitePlugin | undefined
  if (commentsPlugin) {
    await commentsPlugin.api.setComponents([])
    // Templates are generated after the entire components:extend chain, including later modules and dev rescans.
    nuxt.hook?.("app:templatesGenerated", app => commentsPlugin.api.setComponents(app.components))
  }
  const retainedKVPlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/kv/vite")
  const envPlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/env/vite") as Plugin & {
    api?: {
      prepareTypes?: (declarations: EnvDeclarations | undefined, viteRoot: string) => Promise<void>
      resolveDeclarations?: (config: object) => EnvDeclarations | undefined
      resolveProjectRoot?: (viteRoot: string) => string
    }
  } | undefined
  if (envPlugin) {
    for (const plugin of replayPlugins) deploymentOutputEnvPluginHandler(plugin)?.(envPlugin)
  }
  if (options.env !== false) await envPlugin?.api?.prepareTypes?.(envPlugin.api.resolveDeclarations?.(viteConfig), viteRoot)
  const emailPluginCandidate: unknown = replayPlugins.find(plugin => plugin.name === "@vite-hub/email/vite")
  // SAFETY: The plugin name identifies the ViteHub Email plugin and its public preparation API.
  const emailPlugin = emailPluginCandidate as
    | (Plugin & {
        api?: {
          prepareTypes?: (options: {
            materialize?: boolean
            projectRoot: string
            serverDirs?: string[]
          }) => Promise<Record<string, string>>
        }
      })
    | undefined
  const emailTemplatePaths =
    (await emailPlugin?.api?.prepareTypes?.({
      materialize: true,
      projectRoot,
      serverDirs: resolveNuxtServerDirs(nuxt.options),
    })) ?? {}
  const emailCleanupCandidate: unknown = replayPlugins.find(
    plugin => plugin.name === "@vite-hub/email/optional-peer-resolver",
  )
  // SAFETY: The plugin name identifies the ViteHub Email cleanup plugin preparation API.
  const emailCleanupPlugin = emailCleanupCandidate as
    | (Plugin & {
        api?: { prepareTypes?: (root: string) => Promise<void> }
      })
    | undefined
  if (!emailPlugin) await emailCleanupPlugin?.api?.prepareTypes?.(projectRoot)
  // SAFETY: The plugin name identifies the ViteHub Source plugin and its public preparation API.
  const sourcePlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/source/vite") as Plugin & {
    api?: {
      onGeneratedHandlersChanged?: (
        listener: (handlers: GeneratedSourceHandler[]) => Promise<void> | void,
        options?: { handlesHostRestart?: boolean, projectRoot?: string },
      ) => () => void
      prepareSources?: (options: {
        projectRoot: string
        serverDirs?: string[]
      }) => Promise<GeneratedSourceHandler[]>
    }
  } | undefined
  let generatedSourceHandlers = await sourcePlugin?.api?.prepareSources?.({
    projectRoot,
    serverDirs: resolveNuxtServerDirs(nuxt.options),
  }) ?? []
  // SAFETY: The plugin name identifies the Connections preparation API.
  const connectionsPlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/connections/vite" || plugin.name === "@vite-hub/connections/types-cleanup") as Plugin & {
    api?: { prepareTypes?: (options: { projectRoot: string, serverDirs?: string[] }) => Promise<void> }
  } | undefined
  await connectionsPlugin?.api?.prepareTypes?.({
    projectRoot: viteRoot,
    serverDirs: resolveNuxtServerDirs(nuxt.options),
  })
  const typesPlugin = replayPlugins.find(plugin => plugin.name === "vite-hub/types") as Plugin & {
    api?: {
      prepareTypes?: (options: { projectRoot: string }) => Promise<void>
      setPrepareSources?: (prepareSources: ((options: {
        projectRoot: string
        serverDirs?: string[]
      }) => Promise<GeneratedSourceHandler[]>) | undefined) => void
    }
  } | undefined
  let generatedSourceRestart = Promise.resolve()
  let generatedSourceRestartClosed = false
  const removeGeneratedHandlersListener = sourcePlugin?.api?.onGeneratedHandlersChanged?.((handlers: GeneratedSourceHandler[]) => {
    const restart = generatedSourceRestart.then(async () => {
      if (generatedSourceRestartClosed) return
      const previousHandlers = generatedSourceHandlers
      generatedSourceHandlers = handlers
      try {
        await typesPlugin?.api?.prepareTypes?.({ projectRoot })
        if (generatedSourceRestartClosed) return
        await nuxt.callHook?.("restart")
      }
      catch (error) {
        generatedSourceHandlers = previousHandlers
        throw error
      }
    })
    generatedSourceRestart = restart.catch(() => {})
    return restart
  }, { handlesHostRestart: true, projectRoot })
  if (removeGeneratedHandlersListener) {
    nuxt.hook?.("close", async () => {
      generatedSourceRestartClosed = true
      removeGeneratedHandlersListener()
    })
  }
  if (nuxt.options.dev && !nuxt.options.vitehubCliDiscovery) publishNuxtDevServer(nuxt)
  typesPlugin?.api?.setPrepareSources?.(sourcePlugin?.api?.prepareSources)
  await typesPlugin?.api?.prepareTypes?.({ projectRoot })

  viteConfig.define = {
    ...viteConfig.define,
    __VITEHUB_APP_BASE_URL__: JSON.stringify(nuxt.options.app?.baseURL || "/"),
  }
  viteConfig[VITEHUB_GENERATED_ROOT] = join(nuxt.options.buildDir, "vitehub")
  viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT] = true
  viteConfig[VITEHUB_PROJECT_ROOT] = projectRoot
  viteConfig[VITEHUB_APP_BASE_URL] = nuxt.options.app?.baseURL || "/"
  const viteServerDirs = resolveNuxtServerDirs(nuxt.options)
  if (viteServerDirs) viteConfig[VITEHUB_SERVER_DIRS] = viteServerDirs
  const installedVitePlugins: unknown = [
    ...plugins.map(plugin => existingPluginsByName.get(plugin.name) || plugin),
    ...filterPluginOptions(existing, plugin => !plugins.some(candidate => candidate.name === plugin.name)),
  ]
  // SAFETY: Both arrays contain Vite plugins normalized or preserved by this integration.
  nuxt.options.vite.plugins = installedVitePlugins as PluginOption[]
  const configuredEnvProjectRootOption = options.env && typeof options.env === "object"
    ? options.env.projectRoot
    : undefined
  const configuredEnvProjectRoot = configuredEnvProjectRootOption
    ? resolve(viteRoot, configuredEnvProjectRootOption)
    : undefined
  const envProjectRoot = envPlugin?.api?.resolveProjectRoot?.(viteRoot) ?? configuredEnvProjectRoot ?? projectRoot
  if (envPlugin?.api?.resolveProjectRoot && configuredEnvProjectRoot) {
    if (configuredEnvProjectRoot !== envProjectRoot) {
      throw viteHubErrorDiagnostics.VITE_HUB_B0011({ message: `[vitehub] Env projectRoot ${JSON.stringify(configuredEnvProjectRootOption)} conflicts with the installed Env Vite plugin.` })
    }
  }
  const generatedAliases: Record<string, string> = {
    ...(options.env === false ? {} : createEnvImportAliases({ projectRoot: envProjectRoot })),
    ...(!nuxt.options.dev ? Object.fromEntries(Object.entries(emailTemplatePaths).map(([name, path]) => [
        `#vitehub/emails/${name}`,
        path,
      ])) : {}),
    ...(emailPlugin && !nuxt.options.dev
      ? { "#vitehub/emails": join(projectRoot, ".vitehub/email/templates") }
      : {}),
  }
  // Registered after every module's own hook. @nuxtjs/mcp-toolkit points `h3` at nitropack's H3 1 on every Nitro, and
  // Nitro 3's runtime then cannot import `h3/rules`. Nuxt 5 gives Nitro 2 modules H3 1 through its compatibility layer.
  nuxt.hook?.("modules:done", () => {
    nuxt.hook?.("nitro:config", async (config) => {
      const alias = isRecord(config.alias) ? config.alias : undefined
      if (typeof alias?.h3 !== "string") return
      const manifest = findPackageJSON(pathToFileURL(alias.h3), import.meta.url)
      const pkg: unknown = manifest ? JSON.parse(readFileSync(manifest, "utf8")) : undefined
      if (isRecord(pkg) && pkg.name === "h3" && typeof pkg.version === "string" && pkg.version.startsWith("1.")) delete alias.h3
    })
  })
  const nitro3ExternalLists = new WeakMap<object, readonly unknown[]>()
  nuxt.hook?.("nitro:config", async (config) => {
    // An explicit false becomes a selective list below; retain its policy when the same config is replayed.
    const previousExternalList = nitro3ExternalLists.get(config)
    if (previousExternalList && config.noExternals === previousExternalList) config.noExternals = false
    const incomingNoExternals = config.noExternals
    const {
      config: replayConfig,
      hasReplayedDatabaseDiscoveryRoot,
      replayedDatabaseDiscoveryRoot,
    } = await applyNitroConfig(replayPlugins, config, nuxt, projectRoot)
    if (options.env !== false) await envPlugin?.api?.prepareTypes?.(envPlugin.api.resolveDeclarations?.(replayConfig), viteRoot)
    // The replayed hooks can write declarations, such as the Blob store names. `nuxt prepare` builds nothing after this
    // hook, so reference them in `.vitehub/types.d.ts` now.
    await typesPlugin?.api?.prepareTypes?.({ projectRoot })
    consoleWorkflowConfigResolved = true
    // Replayed Vite plugins can change the Database configuration and its discovery root.
    const replayedDatabase = hasReplayedDatabaseDiscoveryRoot
      ? getResolvedFeatureOptions<typeof options.database>(replayConfig, "database") ?? options.database
      : options.database
    await writeNuxtAgentJournal(
      replayedDatabase && replayedDatabase !== true && hasReplayedDatabaseDiscoveryRoot
        ? { ...replayedDatabase, projectRoot: replayedDatabaseDiscoveryRoot }
        : replayedDatabase,
      hasReplayedDatabaseDiscoveryRoot ? projectRoot : journalDatabaseRoot,
    )
    if (consoleOptions) {
      const resolvedKV = resolvedKVFromPlugin(retainedKVPlugin, effectiveKV)
      const replayedBlob = getResolvedFeatureOptions<ViteHubOptions["blob"]>(replayConfig, "blob") ?? effectiveBlob
      const replayedExplicitBlob = Boolean(replayedBlob && replayedBlob !== true && ("driver" in replayedBlob || "stores" in replayedBlob))
      const replayedBlobEnabled = Boolean(replayedBlob) && (plan.services.blob.supported || replayedExplicitBlob)
      const resolvedReplayedBlob = replayedBlobEnabled
        ? requireOptionalOwner(ownerModules.blobVite, "blob").resolveBlobViteConfig(replayedBlob === true ? undefined : replayedBlob, { hosting: plan.nitroPreset }).blob
        : false
      const resolvedSections = resolveConsoleSectionIds({
        ...options,
        auth: consoleHasPrimaryAuth,
        env: options.env !== false,
        blob: replayedBlobEnabled,
        database: getResolvedFeatureOptions(replayConfig, "database") ?? options.database,
        email: options.email,
        kv: resolvedKV,
        preset: plan.preset,
        queue: effectiveQueue === false
          ? false
          : effectiveQueue === undefined
            ? undefined
            : getResolvedFeatureOptions(replayConfig, "queue") ?? effectiveQueue,
        sandboxTask: Boolean(getResolvedFeatureOptions(replayConfig, "sandboxTask") ?? options.sandboxTask) && plan.services.sandbox.supported,
        workspace: options.workspace,
        workflow: options.workflow,
      })
      const entrySections = await discoverConsoleEntrySections({ discoveryRoot: viteRoot, projectRoot, serverDirs: resolveNuxtServerDirs(nuxt.options) })
      consoleSections.splice(0, consoleSections.length, ...new Set([...resolvedSections, ...entrySections]))
      if (nuxt.options.dev) consoleSections.splice(0, consoleSections.length, ...insertConsoleSection(consoleSections, "setup"))
      consoleBlobStores.splice(
        0,
        consoleBlobStores.length,
        ...(resolvedReplayedBlob ? Object.keys(resolvedReplayedBlob.stores || { default: resolvedReplayedBlob.store }) : []),
      )
      installConsoleSections(projectRoot, consoleSections)
      installConsoleProjectName(projectRoot, resolveConsoleProjectNameFromRoot(projectRoot))
      addConsoleRpcHandler(config, consoleRuntimeRoot)
      addConsoleAppRoutes(config, consoleRuntimeRoot)
      // CLI discovery resolves no Console access, so its plugin would differ from the running dev server's and make
      // that server rebuild. The Vite Console plugin skips this write in CLI discovery too.
      if (!nuxt.options.vitehubCliDiscovery) {
        const consoleCatalog = await discoverConsoleBuildCatalog({
          contentImportBase: "vite-hub/content",
          databaseDiscoveryRoot: hasReplayedDatabaseDiscoveryRoot
            ? replayedDatabaseDiscoveryRoot
            : configuredDatabaseDiscoveryRoot,
          discoveryRoot: viteRoot,
          plugins: nuxt.options.vite?.plugins,
          projectRoot,
          queueDiscoveryRoot: rootDir,
          rateLimitDiscoveryRoot: configuredProjectRoot(viteRoot, getResolvedFeatureOptions(replayConfig, "rateLimit") ?? options.rateLimit),
          rateLimitScanDirs: configuredScanDirs(getResolvedFeatureOptions(replayConfig, "rateLimit") ?? options.rateLimit),
          sections: consoleSections,
          scheduleDiscoveryRoot: configuredProjectRoot(viteRoot, options.schedule),
          serverDirs: resolveNuxtServerDirs(nuxt.options),
          workspaceDiscoveryRoot: configuredProjectRoot(viteRoot, options.workspace),
          workflowDiscoveryRoot: rootDir,
        })
        await writeNuxtConsolePlugin(
          generatedConsolePluginPath ?? resolveGeneratedConsolePlugin(projectRoot),
          consoleCatalog,
        )
      }
    }
    Object.assign(config, mergeGeneratedSourceNitroConfig(config, generatedSourceHandlers))
    // Facade exports, owner runtimes, and generated `.vitehub` modules must resolve generated aliases and virtual modules
    // inside Nitro. Node, which loads external modules, cannot read those aliases.
    addNoExternals(config, ["vite-hub", "@vite-hub/", join(projectRoot, ".vitehub"), h3RuntimeRoot, ...linkedViteHubPackageRoots(projectRoot)])
    if (incomingNoExternals === false && Array.isArray(config.noExternals)) nitro3ExternalLists.set(config, config.noExternals)
    else nitro3ExternalLists.delete(config)
    // When Nuxt builds Nitro in a Vite environment, the ViteHub plugins already run there.
    if (!nuxt.options.experimental?.nitroViteEnvironment) installNitroRuntimeResolvers(config, replayPlugins, {
      root: replayConfig.root || viteRoot,
      serverDirs: resolveNuxtServerDirs(nuxt.options),
    })
    normalizeGeneratedNitroPlugins(config, projectRoot)
    installNitroBuildPlugins(config, [join(projectRoot, ".vitehub"), join(nuxt.options.buildDir, "vitehub")], nuxt.options.dev === true && plan.preset === "cloudflare", consoleSections)
    if (nuxt.options.dev && plan.preset === "cloudflare") {
      const alias = (config.alias ??= {}) as Record<string, string>
      alias["cloudflare:workers"] ??= await writeCloudflareWorkersDevShim(nuxt.options.buildDir)
    }
    if (plan.preset === "cloudflare") {
      if (!nuxt.options.dev) {
        // Nitro 3 reloads its config before the production build.
        const handler = await writeCloudflareAssetsMiddleware(projectRoot);
        const handlers = Array.isArray(config.handlers) ? config.handlers : [];
        if (!handlers.some((entry) => isRecord(entry) && entry.handler === handler))
          config.handlers = [...handlers, { handler, route: "/**", middleware: true }];
      }
      const cloudflare = (config.cloudflare ??= {}) as Record<string, unknown>;
      const envServer = generatedAliases["#vitehub/env/server"];
      if (envServer) {
        const wrangler = (cloudflare.wrangler ??= {}) as Record<string, unknown>
        const alias = (wrangler.alias ??= {}) as Record<string, string>
        const nitroEnvServer = (config.alias as Record<string, string> | undefined)?.["#vitehub/env/server"]
        alias["#vitehub/env/server"] ??= await projectWranglerEnvAlias(typeof config.rootDir === "string" ? config.rootDir : rootDir) ?? nitroEnvServer ?? envServer
      }
      if (cloudflare.nodeCompat === true) {
        const wrangler = isRecord(cloudflare.wrangler) ? cloudflare.wrangler : {}
        const flags: unknown[] = Array.isArray(wrangler.compatibility_flags) ? wrangler.compatibility_flags : []
        const project = await readProjectWranglerConfig(typeof config.rootDir === "string" ? config.rootDir : rootDir)
        const explicit = [...flags, ...(Array.isArray(project?.compatibility_flags) ? project.compatibility_flags : [])]
        // A full opt-out must also stop Nitro itself from adding nodejs_compat.
        if (explicit.includes("no_nodejs_compat")) cloudflare.nodeCompat = false
      }
    }
    if (emailPlugin && nuxt.options.dev) {
      installEmailTemplateResolver(config, join(projectRoot, ".vitehub/email/templates"))
    }
    const alias = (config.alias ??= {}) as Record<string, string>
    for (const [name, path] of Object.entries(generatedAliases)) alias[name] ??= path
    // The Console and Agents bundle KV operations even with KV off, and Nitro refuses their unresolved imports. With KV
    // off, the config says so. vitehub() stubs only the Upstash driver; there a missing config makes the KV runtime fall
    // back to environment defaults.
    const kv = resolvedKVFromPlugin(retainedKVPlugin, effectiveKV)
    if (!kv) {
      const virtual = (config.virtual ??= {}) as Record<string, string>
      if (virtual["#vitehub/kv/config"] === undefined || virtual["#vitehub/kv/config"] === disabledKVConfigModule) {
        virtual["#vitehub/kv/config"] = disabledKVConfigModule
        // Nitro's final Vite environment must also resolve imports from linked workspace packages. Its virtual
        // config alone is not available to Nuxt's bare import resolver in that environment.
        const disabledConfig = join(projectRoot, ".vitehub/nuxt/disabled-kv-config.mjs")
        await mkdir(dirname(disabledConfig), { recursive: true })
        await writeFile(disabledConfig, disabledKVConfigModule, "utf8")
        alias["#vitehub/kv/config"] ??= disabledConfig
      }
    }
    if (!hasUpstashStore(kv)) alias[upstashDriverSpecifier] ??= disabledUpstashDriver
    if (!hasRedisStore(kv)) alias[redisDriverSpecifier] ??= disabledRedisDriver
    addNitroImports(config, serverAutoImports)
  })
  if (options.agent) {
    addVueImports(nuxt, "vite-hub/agent/vue", agentVueComposables)
    // Nuxt disables dependency discovery; prebundle the AI SDK's CommonJS browser dependencies.
    const optimizeDeps = (nuxt.options.vite.optimizeDeps ??= {})
    const include = (optimizeDeps.include ??= [])
    if (!include.includes("vite-hub/agent/vue")) include.push("vite-hub/agent/vue")
  }
  addVueImports(nuxt, "vite-hub/source/client", ["useCollection"])
  if (isPackageInstalled("@vite-hub/decisions")) addVueImports(nuxt, "vite-hub/decisions/vue", ["useChoices"])
  if (isPackageInstalled("@vite-hub/forms") && isPackageInstalled("@formisch/vue")) addVueImports(nuxt, "vite-hub/forms/vue", ["useFormSubmit"])
  if (options.i18n) {
    await requireOptionalOwner(ownerModules.i18nNuxt, "i18n").installI18nNuxt({ options: { plugins: (nuxt.options.plugins ??= []) } }, { importBase: "vite-hub/i18n", nitroMajorVersion: 3, projectRoot })
    addVueImports(nuxt, "vite-hub/i18n/vue", ["useLocale"])
  }
  if (effectiveAuth) {
    const envOptions = options.env || {}
    const { default: hubAuthNuxt } = requireOptionalOwner(await importOptionalOwner("@vite-hub/auth", () => import("@vite-hub/auth/nuxt")), "auth")
    hubAuthNuxt({
      auth: effectiveAuth === true ? undefined : effectiveAuth,
      env: options.env === false
        ? false
        : { projectRoot: envOptions.projectRoot },
      importsFrom: "vite-hub/auth/vue",
      nitro: false,
    }, nuxt)
  }
  const nuxtAlias = (nuxt.options.alias ??= {})
  const nitroAlias = ((nuxt.options.nitro ??= {}).alias ??= {}) as Record<string, string>
  if (emailPlugin && nuxt.options.dev) {
    installEmailTemplateResolver(nuxt.options.nitro, join(projectRoot, ".vitehub/email/templates"))
  }
  for (const [name, path] of Object.entries(generatedAliases)) {
    nuxtAlias[name] ??= path
    nitroAlias[name] ??= path
  }
  if (options.blob) addVueImports(nuxt, "vite-hub/blob/vue", ["useMultipartUpload", "useUpload"])
  if (options.realtime) {
    addVueImports(nuxt, "vite-hub/realtime", ["defineRealtime"])
    addVueImports(nuxt, "vite-hub/realtime/vue", ["useRealtimeTiptap"])
  }
  if (options.database) {
    const nuxtAlias = (nuxt.options.alias ??= {})
    nuxtAlias["@vite-hub/database/runtime/state"] ??= databaseRuntimeState
    if (!nuxt.options.dev) {
      nuxt.hook?.("nitro:config", async (config) => {
        const alias = (config.alias ??= {}) as Record<string, string>
        alias["@vite-hub/database/runtime/state"]
          ??= nuxtAlias["@vite-hub/database/runtime/state"]
      })
    }
  }
  if (consoleOptions) {
    generatedConsolePluginPath = await installConsole({
      nuxt,
      projectRoot,
      sections: consoleSections,
      discovery: {
        contentImportBase: "vite-hub/content",
        databaseDiscoveryRoot: configuredDatabaseDiscoveryRoot,
        discoveryRoot: viteRoot,
        plugins: nuxt.options.vite?.plugins,
        queueDiscoveryRoot: rootDir,
        rateLimitDiscoveryRoot: configuredProjectRoot(viteRoot, options.rateLimit),
        rateLimitScanDirs: configuredScanDirs(options.rateLimit),
        scheduleDiscoveryRoot: configuredProjectRoot(viteRoot, options.schedule),
        serverDirs: resolveNuxtServerDirs(nuxt.options),
        workflowDiscoveryRoot: rootDir,
        workspaceDiscoveryRoot: configuredProjectRoot(viteRoot, options.workspace),
      },
      writeGeneratedPlugin: !nuxt.options.vitehubCliDiscovery,
      invocationRootState: consoleInvocationRootState,
      canDiscoverDefinitions: () => consoleWorkflowConfigResolved,
      access: consoleAccess,
      writePlugin: writeNuxtConsolePlugin,
    })
  }
}

viteHubNuxtModule.getMeta = async () => ({
  // Nuxt 5 then skips its Nitro 2 compatibility scan of this package, which parses every file that the
  // module's server entries import.
  compatibility: { server: "nitro3" },
  configKey: "vitehub",
  name: "vite-hub/nuxt",
})

viteHubNuxtModule.getModuleDependencies = async () => {
  // Nuxt asks for the dependencies first on each start of the app, also after a start that failed before Vite closed
  // its plugins. Forget the package checks of an earlier start, so a reload sees the packages installed since then.
  startPackageChecks()
  if (!isPackageInstalled("@nuxt/ui")) return {}
  const ui = await importOptionalOwner("@vite-hub/ui", () => import("@vite-hub/ui/nuxt"))
  return ui?.viteHubUIIconDependencies ?? {}
}

export default viteHubNuxtModule

function usesOnlyPostgresDatabases(rootDir: string, serverDirs: string[] | undefined) {
  const { discoverDatabaseDefinitions, readDatabaseDefinitionDialect } = requireOptionalOwner(ownerModules.databaseConfig, "database")
  const definitions = discoverDatabaseDefinitions(rootDir, { serverDirs })
  return definitions.length > 0 && definitions.every(definition => readDatabaseDefinitionDialect(definition.handler) === "postgresql")
}
