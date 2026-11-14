import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { addViteHubDevPeerDevHandler, addViteHubDevPeerUpgradeSigner } from "@vite-hub/internal/dev-peer"
import { viteHubPageToolsBase } from "@vite-hub/internal/build/page-tools"
import { getResolvedFeatureOptions, isProductionBuild, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { viteHubBasePath } from "@vite-hub/internal/runtime/page-tools-shared"

import type { ResolvedAuthViteConfig } from "@vite-hub/auth"
import { removeViteHubDevServerFile, writeViteHubDevServerFile } from "@vite-hub/internal/cli"
import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { OperationContributingPlugin, OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Environment, Plugin, ViteDevServer } from "vite"
import { insertConsoleSection, type ConsoleSectionId } from "./runtime/sections.ts"

import { discoverConsoleBuildCatalog } from "./build.ts"
import { consoleRuntimeRoot, consoleSkillsRoot, writeConsoleNitroPlugin, type ConsoleAccessBuild, type ConsoleNitroPluginOptions } from "./plugin.ts"
import { serializeConsoleRefresh } from "./refresh.ts"
import { bindConsoleInvocationsIdentity, createConsoleInvocationsIdentity, releaseConsoleInvocationsBinding } from "./internal.ts"
import { addConsolePageToolRoutes, addConsoleRpcHandler } from "./nitro.ts"
import { consoleOperationFeaturesFilter, transformConsoleOperationFeatures } from "./operation-features.ts"
import { consoleDevAccessNotice } from "./dev-access-notice.ts"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

const frameworkAgentSpecifier = "vite-hub/agent"
const generatedConsolePlugin = ".vitehub/nitro/console/plugin.mjs"

export function resolveGeneratedConsolePlugin(root: string): string {
  return resolve(root, generatedConsolePlugin)
}

type ConsoleNitroConfig = {
  handlers?: Array<{ handler: string, method?: string, route: string }>
  plugins?: string[]
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean, maxAge?: number }>
  [key: string]: unknown
}

/**
 * The Console options. `console: true` is the same as `console: {}`.
 * The app serves one Console route, `POST /_vitehub/rpc`. It takes only requests that the ViteHub Console or the CLI
 * signed with an Ed25519 key whose public key is in a `VITEHUB_CONSOLE_KEY_<NAME>` runtime env var.
 */
export interface ConsoleOptions {
  /**
   * `false` takes calls without a signature, from this machine only, for `vite dev`. A production build fails. Leave it
   * out to take only signed calls.
   */
  auth?: false
  /**
   * Server file that default-exports `defineConsoleAuthorize()`. Every Console call runs it after the signature check.
   * It returns `true`, `false`, a `Response`, or `{ sections }` to allow only some Console sections.
   */
  authorize?: string
  /**
   * Let Console administrators open the app as one of its users. Off by default. It needs app Auth with Better Auth's
   * `admin` plugin and `events.store`, so that every start and stop is recorded.
   */
  impersonation?: boolean
  /** Let the Console start Agent Invocations and run manual Schedules. Defaults to `true` in development and `false` in production builds. */
  invoke?: boolean
  /**
   * Sections to leave out of this Console, such as `{ content: false }`. A hidden section has no navigation entry and
   * no Console routes. It does not change the primitive itself: the app still reads and writes its content.
   */
  sections?: Readonly<Record<string, false>>
  /**
   * Show the MCP client section: it connects to MCP servers as the person who signed in to the Console, with OAuth or a
   * token. It lists the servers that the app announces in its RFC 9728 metadata, such as its own `/mcp`.
   */
  mcpClient?: boolean
}

/** Direct plugin use without Console options in development installs the development-only `local` policy. */
interface LocalConsoleOptions extends ConsoleOptions {
  local: true
}

const localDevelopmentConsole: Readonly<LocalConsoleOptions> = Object.freeze({ auth: false, local: true })

const consoleGuide = "https://vitehub.dev/docs/console/migrate"

/** Options that the Console had before it moved out of apps, with the change that replaces each one. */
const removedConsoleOptions: Record<string, string> = {
  databaseUrl: "The Agent Invocation journal does not depend on the Console. Set agent: { invocations: { databaseUrl } } in vitehub() instead.",
  observations: "The Agent Invocation journal does not depend on the Console. Set agent: { invocations: { observations } } in vitehub() instead.",
  retention: "The Agent Invocation journal does not depend on the Console. Set agent: { invocations: { retention } } in vitehub() instead.",
  embed: `Apps do not serve the Console page. Open the app in the ViteHub Console at https://console.vitehub.dev. Remove console.embed. See ${consoleGuide}`,
  mcp: `Apps do not serve a Console MCP at /_vitehub/mcp. Agents use the ViteHub MCP of the Console at https://console.vitehub.dev/mcp. Remove console.mcp. See ${consoleGuide}`,
  origins: `Apps take no Console calls from browsers. The ViteHub Console signs calls on its server. Remove console.origins. See ${consoleGuide}`,
  signInPage: `Apps do not serve a Console sign-in page. People sign in to the ViteHub Console at https://console.vitehub.dev. Remove console.signInPage. See ${consoleGuide}`,
}

/** The fix of a removed `console.auth` value. */
function removedConsoleAuth(auth: unknown): string | undefined {
  if (auth === "token") return 'console.auth: "token" was removed. Signed calls are the default now. Remove console.auth, or set console: true.'
  if (auth === "app") return `console.auth: "app" was removed. Apps do not sign people in to the Console. Set console: true, link the app in the ViteHub Console at https://console.vitehub.dev, and set the VITEHUB_CONSOLE_KEY_<NAME> line that it shows. Move a check of the person to console.authorize, which gets the signed Console user. See ${consoleGuide}`
  if (auth instanceof Object && !Array.isArray(auth)) return `console.auth: { ... } (Console Auth with a server file, GitHub, or Cloudflare Access) was removed. People sign in to the ViteHub Console at https://console.vitehub.dev. Set console: true and set the VITEHUB_CONSOLE_KEY_<NAME> line that the Console shows when you link the app. See ${consoleGuide}`
  return undefined
}

/**
 * Validate the `console` option at the ViteHub boundary. Returns `undefined` when the Console is off. Removed options
 * fail with the change that replaces them.
 */
export function resolveConsoleOptions(value: unknown): ConsoleOptions | undefined {
  if (value === undefined || value === false) return undefined
  if (value === true) return {}
  if (!(value instanceof Object) || Array.isArray(value)) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: '[vitehub] console must be true, false, or an options object, such as console: { authorize: "./server/console-authorize.ts" }.' })
  }
  for (const [key, fix] of Object.entries(removedConsoleOptions)) {
    if (Reflect.get(value, key) !== undefined) throw viteHubErrorDiagnostics.VITE_HUB_B0020({ message: `[vitehub] console.${key} was removed. ${fix}` })
  }
  const auth: unknown = Reflect.get(value, "auth")
  const removed = removedConsoleAuth(auth)
  if (removed) throw viteHubErrorDiagnostics.VITE_HUB_B0020({ message: `[vitehub] ${removed}` })
  if (auth !== undefined && auth !== false) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: "[vitehub] console.auth must be false, for development without signed calls, or left out." })
  }
  const impersonation: unknown = Reflect.get(value, "impersonation")
  if (impersonation !== undefined && impersonation !== true && impersonation !== false) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: "[vitehub] console.impersonation must be true or false." })
  }
  const sections: unknown = Reflect.get(value, "sections")
  if (sections !== undefined && (!(sections instanceof Object) || Array.isArray(sections) || Object.values(sections).some(entry => entry !== false))) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: "[vitehub] console.sections maps a section id to false, such as { content: false }." })
  }
  // SAFETY: `auth`, `impersonation`, and `sections` are checked above. The other fields keep their documented types and are checked where they are read.
  return value as ConsoleOptions
}

export interface ConsoleVitePluginOptions {
  /** Serve the development RPC and Setup without the full Console. */
  rpcOnly?: boolean
  contentImportBase?: string
  blobStores?: readonly string[]
  console?: ConsoleOptions
  runtimeCapabilityImports?: Record<string, false | string>
  databaseDiscoveryRoot?: string
  rateLimitDiscoveryRoot?: string
  rateLimitScanDirs?: string[]
  resolveAuthConfig?: (root: string, serverDirs: string[] | undefined) => ResolvedAuthViteConfig | undefined
  resolveBlobStores?: (blob: unknown) => readonly string[] | false
  /** Whether the effective KV configuration enables the section, including a standalone KV plugin. */
  resolveKV?: (kv: unknown, plugins?: readonly Plugin[]) => boolean
  invocationRootState?: ConsoleInvocationRootState
  /** Enabled operation owners when the development RPC has no navigation sections. */
  operationSections?: readonly ConsoleSectionId[]
  sections?: readonly ConsoleSectionId[]
  scheduleDiscoveryRoot?: string
  workspaceDiscoveryRoot?: string
}

export interface ConsoleInvocationRootState {
  binding?: string
  closed?: boolean
  identity?: string
  projectRoot?: string
}

export function createConsoleInvocationRootState(): ConsoleInvocationRootState {
  return { binding: randomUUID() }
}

export async function closeConsoleInvocationRootState(state: ConsoleInvocationRootState): Promise<void> {
  if (state.closed) return
  state.closed = true
  if (state.binding) releaseConsoleInvocationsBinding(state.binding)
}

export function updateConsoleInvocationRootState(
  state: ConsoleInvocationRootState,
  projectRoot: string,
  identity: string,
): void {
  if (state.closed) return
  state.binding ??= randomUUID()
  state.identity = identity
  state.projectRoot = projectRoot
  bindConsoleInvocationsIdentity(state.binding, identity, projectRoot)
}

function configureConsoleNitroRoutes(
  nitro: ConsoleNitroConfig,
  baseURL: string,
  sections: readonly ConsoleSectionId[],
  rpcOnly = false,
): { kit: ReturnType<typeof createNitroServerKit>, publicAssets: NonNullable<ConsoleNitroConfig["publicAssets"]> } {
  // Nitro serves its routes below its own `baseURL`, so the routes get only the part of the Vite base that Nitro does not
  // add. Without a Nitro `baseURL`, this is the whole Vite base.
  const mount = viteHubPageToolsBase({ base: baseURL, nitro }).mount
  const kit = createNitroServerKit({ ...nitro, handlers: Array.isArray(nitro.handlers) ? [...nitro.handlers] : [] })
  addConsoleRpcHandler(kit.config, consoleRuntimeRoot, mount)
  // The development RPC without Console options has no Console link in the page tools pill.
  if (!rpcOnly) addConsolePageToolRoutes(kit.config, consoleRuntimeRoot, mount)
  const userPublicAssets = (kit.config.publicAssets as ConsoleNitroConfig["publicAssets"] ?? [])
    .filter(asset => asset?.dir !== consoleSkillsRoot)
  // Without a `console` option, `vite dev` serves only the RPC, so the CLI can call operations.
  const publicAssets = [...rpcOnly
    ? []
    : [{
        // Static files, so the skills CLI reads them without a signature. They are the public ViteHub skill.
        baseURL: consoleMountPath(mount, "/_vitehub/.well-known/skills"),
        dir: consoleSkillsRoot,
        fallthrough: false,
      }], ...userPublicAssets]
  return { kit, publicAssets }
}

function consoleMountPath(base: string | undefined, path: string): string {
  return `${viteHubBasePath(base)}${path}`
}

/** Reject a production build that takes Console calls without a signature. */
export function assertConsoleProductionAuth(configured: ConsoleOptions): void {
  if (configured.auth !== false) return
  throw viteHubErrorDiagnostics.VITE_HUB_B0022({ message: "[vitehub] console.auth false is for development. Remove console.auth so the app takes only signed calls, and set the VITEHUB_CONSOLE_KEY_<NAME> line that the ViteHub Console shows when you link the app (or that vitehub secret console-key prints)." })
}

/** Resolve the `console.authorize` file. A configured path must exist. */
export function resolveConsoleAuthorizeFile(root: string, authorize: unknown): string | undefined {
  if (authorize === undefined) return
  if (typeof authorize !== "string" || !authorize.trim()) throw new TypeError("[vitehub] console.authorize must be a path to a server file.")
  const file = resolve(root, authorize)
  if (!existsSync(file)) throw new TypeError(`[vitehub] console.authorize file does not exist: ${file}`)
  return file
}

/**
 * Resolve the access policy that generated output installs for the Console route.
 * - Without `auth: false`, only signed calls get in.
 * - `auth: false` is open, for development.
 * - `authorize` runs after either check.
 */
export function resolveConsoleAccessBuild(configured: ConsoleOptions, options: { root: string }): ConsoleAccessBuild {
  if ("local" in configured && configured.local === true) return { mode: "local" }
  const authorize = resolveConsoleAuthorizeFile(options.root, configured.authorize)
  return {
    mode: configured.auth === false ? "open" : "token",
    ...(authorize ? { authorize } : {}),
    ...(configured.impersonation === true ? { impersonation: true as const } : {}),
    ...(configured.sections && Object.keys(configured.sections).length ? { hiddenSections: Object.keys(configured.sections) } : {}),
  }
}

/** Check the Console options against the app: `console.impersonation` needs app Auth. */
export function assertConsoleAccess(configured: ConsoleOptions, options: { auth?: ResolvedAuthViteConfig }): void {
  if (configured.impersonation === true && !options.auth) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0005({ message: "[vitehub] console.impersonation needs app Auth. Set auth: true and add server/auth.ts with Better Auth's admin plugin, or remove console.impersonation." })
  }
}

export function generatedConsolePluginRegistration(value: string): boolean {
  const normalized = value.replaceAll("\\", "/")
  return normalized === generatedConsolePlugin
    || /\/\.vitehub\/nitro\/console\/plugin(?:-[^/]+)?\.mjs$/.test(normalized)
}

export function consoleVitePlugin(options: ConsoleVitePluginOptions): Plugin {
  let sections = options.sections ?? []
  let blobStores = options.blobStores ?? []
  let generatedPlugin: string | undefined
  let databaseDiscoveryRoot: string | undefined
  let projectRoot: string | undefined
  let rateLimitDiscoveryRoot: string | undefined
  let rateLimitScanDirs: string[] | undefined
  let root: string | undefined
  let serverDirs: string[] | undefined
  let scheduleDiscoveryRoot: string | undefined
  let workspaceDiscoveryRoot: string | undefined
  let resolvedPlugins: readonly unknown[] | undefined
  let cliDiscovery = false
  let development = false
  let invoke = false
  let resolvedConsoleConfiguration: ConsoleOptions | undefined
  const consoleBuildCatalogs = new Map<string, Awaited<ReturnType<typeof discoverConsoleBuildCatalog>>>()
  let baseURL = "/"
  let applicationBase = "/"

  function consoleAccess(): ConsoleAccessBuild | undefined {
    if (!resolvedConsoleConfiguration || !root) return
    return resolveConsoleAccessBuild(resolvedConsoleConfiguration, { root })
  }

  /** The options of the generated Console Nitro plugin, read from the current state when it is written. */
  function consolePluginOptions(): Omit<ConsoleNitroPluginOptions, "catalog" | "file" | "projectRoot"> {
    return {
      access: consoleAccess(),
      active: () => !options.invocationRootState?.closed,
      blobStores,
      development,
      invoke,
      runtimeCapabilityImports: options.runtimeCapabilityImports,
      sections,
      navigationSections: options.rpcOnly ? sections.filter(section => section === "setup") : undefined,
      ...(options.rpcOnly ? {} : { pageTool: { base: applicationBase } }),
    }
  }

  const refreshConsoleCatalog = serializeConsoleRefresh(async () => {
    if (!generatedPlugin || !projectRoot || !root) return
    const catalog = await discoverConsoleBuildCatalog({ contentImportBase: options.contentImportBase, databaseDiscoveryRoot, databaseImplicitDefault: true, discoveryRoot: root, plugins: resolvedPlugins, projectRoot, rateLimitDiscoveryRoot, rateLimitScanDirs, sandboxTaskDiscoveryRoot: root, scheduleDiscoveryRoot, sections, serverDirs, workspaceDiscoveryRoot })
    consoleBuildCatalogs.set(projectRoot, catalog)
    const identity = await writeConsoleNitroPlugin({ ...consolePluginOptions(), catalog, file: generatedPlugin, projectRoot })
    if (options.invocationRootState) updateConsoleInvocationRootState(options.invocationRootState, projectRoot, identity)
  })

  function resolveKVRegistration(kv: unknown, plugins?: readonly Plugin[]): void {
    sections = sections.filter(section => section !== "kv")
    if (options.resolveKV?.(kv, plugins) !== false) sections = [...sections, "kv"]
  }

  function resolveBlobRegistration(blob: unknown): void {
    if (!options.resolveBlobStores) return
    const resolvedBlobStores = options.resolveBlobStores?.(blob)
    sections = sections.filter(section => section !== "blob")
    if (resolvedBlobStores !== false) sections = [...sections, "blob"]
    blobStores = resolvedBlobStores === false ? [] : resolvedBlobStores ?? options.blobStores ?? []
  }

  function resolveWorkflowRegistration(workflow: unknown): void {
    sections = sections.filter(section => section !== "workflows")
    if (workflow) sections = [...sections, "workflows"]
  }

  function resolveQueueRegistration(queue: unknown): void {
    const configured = queue ?? options.sections?.includes("queues")
    sections = sections.filter(section => section !== "queues")
    if (configured) sections = [...sections, "queues"]
  }

  const plugin: Plugin & { vitehub: NonNullable<ViteHubCliContributingPlugin["vitehub"]> & NonNullable<OperationContributingPlugin["vitehub"]> } = {
    name: "vite-hub/console",
    // Nitro 3 runs the app in a worker that never sees the client's address. Its front process signs loopback requests.
    nitro: {
      setup(nitro) {
        if (nitro.options.dev) addViteHubDevPeerDevHandler(nitro.options.devHandlers)
      },
    },
    transform: {
      filter: consoleOperationFeaturesFilter,
      handler(code) {
        const transformed = transformConsoleOperationFeatures(code, options.operationSections ?? sections)
        return transformed === undefined ? undefined : { code: transformed, map: null }
      },
    },
    async config(config, environment) {
      development = environment.command === "serve"
      // The Setup section writes the project, so only a development server has it.
      if (development) sections = insertConsoleSection(sections, "setup")
      root = resolve(config.root || process.cwd())
      const configured: ConsoleOptions | undefined = resolveConsoleOptions(options.console) ?? (environment.command === "serve" ? localDevelopmentConsole : undefined)
      // Without Console options the RPC is development-only, and the plugin applies only to `serve`.
      if (!configured && options.rpcOnly) return
      // The root integration does not add this plugin without Console options, so this only guards direct use.
      if (!configured) throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: "[vitehub] The Console plugin needs Console options. Set console: true in vitehub()." })
      resolvedConsoleConfiguration = configured
      // SAFETY: Server discovery and the CLI extend Vite's user config with these private keys.
      const viteConfig = config as typeof config & {
        [VITEHUB_SERVER_DIRS]?: string[]
        vitehubCliDiscovery?: true
      }
      const database = getResolvedFeatureOptions<unknown>(config, "database")
      const rateLimit = getResolvedFeatureOptions<unknown>(config, "rateLimit")
      const sandboxTask = getResolvedFeatureOptions<unknown>(config, "sandboxTask")
      resolveBlobRegistration(getResolvedFeatureOptions(config, "blob"))
      resolveKVRegistration(undefined)
      resolveQueueRegistration(getResolvedFeatureOptions(config, "queue"))
      resolveWorkflowRegistration(options.sections?.includes("workflows"))
      if (database !== undefined) {
        sections = sections.filter(section => section !== "databases")
        if (database) sections = [...sections, "databases"]
      }
      if (sandboxTask !== undefined) {
        sections = sections.filter(section => section !== "sandbox-tasks")
        if (sandboxTask) sections = [...sections, "sandbox-tasks"]
      }
      const configuredProjectRoot = (value: unknown): string | undefined => value && typeof value === "object" && "projectRoot" in value
        && typeof value.projectRoot === "string"
        ? resolve(root!, value.projectRoot)
        : undefined
      databaseDiscoveryRoot = configuredProjectRoot(database) ?? configuredProjectRoot({ projectRoot: options.databaseDiscoveryRoot })
      rateLimitDiscoveryRoot = configuredProjectRoot(rateLimit) ?? configuredProjectRoot({ projectRoot: options.rateLimitDiscoveryRoot })
      rateLimitScanDirs = rateLimit && typeof rateLimit === "object" && "scanDirs" in rateLimit && Array.isArray(rateLimit.scanDirs)
        ? rateLimit.scanDirs.filter((value): value is string => typeof value === "string")
        : options.rateLimitScanDirs
      scheduleDiscoveryRoot = configuredProjectRoot({ projectRoot: options.scheduleDiscoveryRoot })
      workspaceDiscoveryRoot = configuredProjectRoot({ projectRoot: options.workspaceDiscoveryRoot })
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      cliDiscovery = viteConfig.vitehubCliDiscovery === true
      const appAuth = options.resolveAuthConfig?.(root, viteConfig[VITEHUB_SERVER_DIRS]);
      sections = sections.filter((section) => section !== "auth");
      if (appAuth) sections = insertConsoleSection(sections, "auth");
      baseURL = viteHubPageToolsBase(config).base || "/"
      applicationBase = baseURL
      assertConsoleAccess(configured, { auth: appAuth })
      if (isProductionBuild(config, environment) && !cliDiscovery) assertConsoleProductionAuth(configured)
      projectRoot = resolveViteHubProjectRoot(root)
      const build = environment.command === "build"
      invoke = configured.invoke ?? !build
      generatedPlugin = resolveGeneratedConsolePlugin(projectRoot)
      if (!cliDiscovery) {
        const resolvedOnlySections = new Set<ConsoleSectionId>(["databases", "sandbox-tasks", "workflows", "workspaces"])
        const initialSections = sections.filter(section => !resolvedOnlySections.has(section))
        const catalog = await discoverConsoleBuildCatalog({ contentImportBase: options.contentImportBase, databaseDiscoveryRoot, databaseImplicitDefault: true, discoveryRoot: root, projectRoot, rateLimitDiscoveryRoot, rateLimitScanDirs, sandboxTaskDiscoveryRoot: root, scheduleDiscoveryRoot, sections: initialSections, serverDirs, workspaceDiscoveryRoot })
        consoleBuildCatalogs.set(projectRoot, catalog)
        await writeConsoleNitroPlugin({ ...consolePluginOptions(), catalog, file: generatedPlugin, projectRoot })
      }
      // SAFETY: Nitro extends Vite's user config with this documented top-level configuration object.
      const consoleConfig = viteConfig as typeof viteConfig & { nitro?: ConsoleNitroConfig }
      const nitro: ConsoleNitroConfig = consoleConfig.nitro
        ? { ...consoleConfig.nitro }
        : {}
      const { kit, publicAssets } = configureConsoleNitroRoutes(nitro, applicationBase, sections, options.rpcOnly)
      if (Array.isArray(kit.config.plugins)) {
        const plugins = kit.config.plugins.filter(candidate => !generatedConsolePluginRegistration(candidate))
        kit.config.plugins.splice(0, kit.config.plugins.length, ...plugins)
      }
      kit.addPlugin(generatedPlugin)
      consoleConfig.nitro = { ...kit.config, publicAssets }
    },
    async configResolved(config) {
      root = config.root
      resolvedPlugins = config.plugins
      baseURL = viteHubPageToolsBase(config).base || "/"
      applicationBase = baseURL
      projectRoot ||= resolveViteHubProjectRoot(config.root)
      generatedPlugin ||= resolve(projectRoot, generatedConsolePlugin)
      // SAFETY: Nitro extends the resolved Vite config with this documented key.
      const viteConfig = config as typeof config & { nitro?: ConsoleNitroConfig }
      const database = getResolvedFeatureOptions<unknown>(config, "database")
      const rateLimit = getResolvedFeatureOptions<unknown>(config, "rateLimit")
      const sandboxTask = getResolvedFeatureOptions<unknown>(config, "sandboxTask")
      resolveBlobRegistration(getResolvedFeatureOptions(config, "blob"))
      resolveKVRegistration(undefined, config.plugins)
      resolveQueueRegistration(getResolvedFeatureOptions(config, "queue"))
      resolveWorkflowRegistration(options.sections?.includes("workflows"))
      const configuredProjectRoot = (value: unknown): string | undefined => value && typeof value === "object" && "projectRoot" in value
        && typeof value.projectRoot === "string"
        ? resolve(root!, value.projectRoot)
        : undefined
      if (database !== undefined) {
        databaseDiscoveryRoot = configuredProjectRoot(database)
        sections = sections.filter(section => section !== "databases")
        if (database) sections = [...sections, "databases"]
      }
      if (rateLimit !== undefined) {
        rateLimitDiscoveryRoot = configuredProjectRoot(rateLimit)
        rateLimitScanDirs = rateLimit && typeof rateLimit === "object" && "scanDirs" in rateLimit && Array.isArray(rateLimit.scanDirs)
          ? rateLimit.scanDirs.filter((value): value is string => typeof value === "string")
          : undefined
      }
      if (sandboxTask !== undefined) {
        sections = sections.filter(section => section !== "sandbox-tasks")
        if (sandboxTask) sections = [...sections, "sandbox-tasks"]
      }
      const { kit, publicAssets } = configureConsoleNitroRoutes(viteConfig.nitro ??= {}, viteHubPageToolsBase(config).base, sections, options.rpcOnly)
      viteConfig.nitro = { ...kit.config, publicAssets }
      generatedPlugin = resolveGeneratedConsolePlugin(projectRoot)
      // SAFETY: VITEHUB_SERVER_DIRS is ViteHub-owned config state populated with string paths.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      if (!cliDiscovery) await refreshConsoleCatalog()
    },
    configureServer(server) {
      publishDevServer(server)
      // Nitro's WebSocket upgrades skip its dev handlers. The listener signs only after the Nitro module made a key.
      if (server.httpServer) addViteHubDevPeerUpgradeSigner(server.httpServer)
      if (resolvedConsoleConfiguration && server.httpServer) {
        const http = server.httpServer
        http.once("listening", () => {
          const notice = consoleDevAccessNotice(consoleAccess()?.mode, http.address())
          if (notice) server.config.logger[notice.level](notice.message)
        })
      }
      const refresh = async () => {
        try {
          await refreshConsoleCatalog()
        }
        catch (error) {
          server.config.logger.error(
            `[vitehub] Could not refresh Console development state: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      server.watcher.on("add", refresh)
      server.watcher.on("change", refresh)
      server.watcher.on("unlink", refresh)
    },
    vitehub: {
      operations: consoleOperationContributions(() => sections),
    },
  }
  return plugin
}

/**
 * The Console operations, for the CLI and `vitehub inspect`. The Console runtime already holds them, so they are not
 * installed again. `sections` is read when the operations load, after the config hooks set it.
 */
export function consoleOperationContributions(sections: () => readonly string[]): OperationContributionEntry[] {
  return [{
    export: "consoleOperations",
    // An app without a Database gets no `vitehub database` commands.
    load: async () => (await import("./runtime/server/operations.ts")).consoleOperations.filter(operation => sections().includes("databases") || !operation.name.startsWith("databases.")),
    module: "vite-hub/console/server",
    runtime: false,
  },
  // The generated Console plugin installs these at runtime.
  ...(sections().includes("mcp-client")
    ? [{
        export: "consoleMcpClientOperations",
        load: async () => (await import("./runtime/server/mcp-client-operations.ts")).consoleMcpClientOperations,
        module: "vite-hub/console/mcp-client",
        runtime: false as const,
      }]
    : [])]
}

/**
 * Tell `vitehub` commands where this dev server listens: `.vitehub/dev-server.json` in the project root, removed when
 * the server closes. A host that runs Vite in middleware mode has no listening server and writes nothing.
 */
function publishDevServer(server: ViteDevServer): void {
  const http = server.httpServer
  // In middleware mode another server owns the listener and publishes it, as the Nuxt module does.
  if (!http || server.config.server.middlewareMode) return
  const root = resolve(server.config.root)
  const write = () => {
    const address = http.address()
    if (!address || typeof address === "string") return
    const host = address.address === "::" || address.address === "0.0.0.0" ? "localhost" : address.family === "IPv6" ? `[${address.address}]` : address.address
    const url = server.resolvedUrls?.local[0] ?? `${server.config.server.https ? "https" : "http"}://${host}:${address.port}${server.config.base}`
    try {
      writeViteHubDevServerFile(root, { root, url })
    }
    catch {
      // A read-only project root only means commands must pass --url.
    }
  }
  const remove = () => {
    try {
      removeViteHubDevServerFile(root)
    }
    catch {
      // The file is advisory.
    }
  }
  if (http.listening) write()
  else http.once("listening", write)
  http.once("close", remove)
}

function normalizeModuleId(id: string): string {
  const queryIndex = id.indexOf("?")
  const path = queryIndex === -1 ? id : id.slice(0, queryIndex)
  return path.replace(/\\/g, "/")
}

export function consoleInvocationRootPlugin(
  configuredProjectRoot?: string,
  configuredIdentity?: string,
  state: ConsoleInvocationRootState = {},
): Plugin {
  const frameworkAgentEntries = new Set<string>()
  const activeEnvironments = new Set<Environment>()
  let projectRoot = configuredProjectRoot
  let identity = configuredIdentity

  function rememberFrameworkAgent(id: string): void {
    frameworkAgentEntries.add(normalizeModuleId(id))
  }

  async function closeEnvironment(environment: Environment | undefined): Promise<void> {
    if (environment) activeEnvironments.delete(environment)
    if (activeEnvironments.size > 0) return
    await closeConsoleInvocationRootState(state)
  }

  return {
    name: "vite-hub/console-invocation-root",
    applyToEnvironment: environment => environment.config.consumer === "server",
    perEnvironmentStartEndDuringDev: true,
    configEnvironment(_name, config) {
      if (config.consumer !== "server") return
      return { resolve: { noExternal: ["vite-hub"] } }
    },
    async configResolved(config) {
      projectRoot ||= resolveViteHubProjectRoot(config.root)
      identity = state.identity ?? createConsoleInvocationsIdentity(projectRoot)
      updateConsoleInvocationRootState(state, projectRoot, identity)
    },
    async closeBundle() {
      await closeEnvironment(this.environment)
    },
    async buildEnd(error) {
      if (error) await closeEnvironment(this.environment)
    },
    async buildStart() {
      if (this.environment) activeEnvironments.add(this.environment)
      if (state.closed) {
        state.closed = false
        if (state.binding && state.identity && state.projectRoot) {
          bindConsoleInvocationsIdentity(state.binding, state.identity, state.projectRoot)
        }
      }
      const resolved = await this.resolve(frameworkAgentSpecifier, undefined, { skipSelf: true })
      if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(frameworkAgentSpecifier)} for the Agent invocation console.`)
      rememberFrameworkAgent(resolved.id)
    },
    resolveId: {
      filter: { id: /^vite-hub\/agent$/ },
      async handler(source, importer, options) {
        if (source !== frameworkAgentSpecifier) return
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
        if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(frameworkAgentSpecifier)} for the Agent invocation console.`)
        rememberFrameworkAgent(resolved.id)
        return { ...resolved, external: false }
      },
    },
    transform(code, id) {
      if (!frameworkAgentEntries.has(normalizeModuleId(id))) return
      if (!projectRoot) this.error("[vitehub] Could not resolve the project root for the Agent invocation console.")
      return [
        `globalThis[Symbol.for("vitehub.console.invocations.root")] = ${JSON.stringify(projectRoot)}`,
        `globalThis[Symbol.for("vitehub.console.invocations.identity")] = ${JSON.stringify(state.identity ?? identity)}`,
        `globalThis[Symbol.for("vitehub.console.invocations.identity-root")] = ${JSON.stringify(projectRoot)}`,
        ...(state.binding
          ? [`globalThis[Symbol.for("vitehub.console.invocations.binding")] = ${JSON.stringify(state.binding)}`]
          : []),
        code,
      ].join("\n")
    },
  }
}
