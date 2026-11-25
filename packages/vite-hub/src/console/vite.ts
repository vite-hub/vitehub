import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { addViteHubDevPeerDevHandler, addViteHubDevPeerUpgradeSigner } from "@vite-hub/internal/dev-peer"
import { viteHubPageToolsBase } from "@vite-hub/internal/build/page-tools"
import { getResolvedFeatureOptions, isProductionBuild, publishViteHubDevServer, resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import type { ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { DeploymentEnvEntry } from "@vite-hub/internal/build/deployment-plan-output"
import type { OperationContributingPlugin, OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Environment, Plugin } from "vite"
import { insertConsoleSection, type ConsoleSectionId } from "./runtime/sections.ts"

import { discoverConsoleBuildCatalog } from "./build.ts"
import { consoleAppModuleHasDocumentEditors, consoleRuntimeRoot, resolveConsoleRuntimeCapabilityImports, writeConsoleAppModule, type ConsoleAccessBuild, type ConsoleAppModuleOptions } from "./app-module.ts"
import { loadConsoleOperations } from "./operation-modules.ts"
import { serializeConsoleRefresh } from "./refresh.ts"
import { addConsoleRpcHandler } from "./nitro.ts"
import { resolveConsoleSiteAccess, type ConsoleSiteComments } from "./site-access.ts"
import { consoleOperationFeaturesFilter, transformConsoleOperationFeatures } from "./operation-features.ts"
import { consoleDocumentEditorSectionIds } from "./contributions.ts"
import { consoleDevAccessNotice } from "./dev-access-notice.ts"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

const generatedConsoleApp = ".vitehub/nitro/console/app.mjs"
const generatedDevelopmentConsoleApp = ".vitehub/nitro/console/app-dev.mjs"

/** The import that the Console routes and the Agent `console` capability use to load the generated Console app module. */
export const consoleAppModuleId = "#vitehub/console/app"

/**
 * The generated Console app module of a project. The Console routes import it on their first request, so it never
 * loads when the server starts. A development server writes its own file: it installs the local access mode and
 * development routes, and it rewrites the file when the project changes. A build that runs while the dev server is up
 * would otherwise bundle that file and ship development access to production.
 */
export function resolveGeneratedConsoleApp(root: string, development = false): string {
  return resolve(root, development ? generatedDevelopmentConsoleApp : generatedConsoleApp)
}

type ConsoleNitroConfig = {
  handlers?: Array<{ handler: string, method?: string, route: string }>
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
   * The origin of the ViteHub Console that opens this app, such as `https://console.example.com` for a self-hosted
   * Console. `/_vitehub` and the links to the Console go there, Site access signs people in there, and the Comments
   * pill loads the Console segment from there. It must be an `https://` origin without a path, or `http://localhost`
   * for a Console on this computer. Defaults to `https://console.vitehub.dev`.
   */
  url?: string
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
  mcpClient: `Apps do not run an MCP client. The MCP client section of the ViteHub Console connects to MCP servers from the Console server, so the app needs no @modelcontextprotocol/sdk and no VITEHUB_CONSOLE_MCP_KEY. Remove console.mcpClient. See ${consoleGuide}`,
  origins: `Apps take no Console calls from browsers. The ViteHub Console signs calls on its server. Remove console.origins. See ${consoleGuide}`,
  pill: `Apps do not add the Console link to their pages. The Comments pill loads the Console segment from the ViteHub Console, and an app without Comments opens through the Console at https://console.vitehub.dev. Remove console.pill. See ${consoleGuide}`,
  signInPage: `Apps do not serve a Console sign-in page. People sign in to the ViteHub Console at https://console.vitehub.dev. Remove console.signInPage. See ${consoleGuide}`,
}

const loopbackConsoleHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

/** The origin of a `console.url` value, or `undefined` when it is not an `https:` origin or a loopback `http:` origin. */
function consoleOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined
  const url = new URL(value)
  const secure = url.protocol === "https:" || (url.protocol === "http:" && loopbackConsoleHosts.has(url.hostname))
  if (!secure || url.username || url.password || url.pathname !== "/" || url.search || url.hash || value.includes("@")) return undefined
  return url.origin
}

/** The origin of the ViteHub Console that the app links to: `console.url`, or `undefined` for the hosted Console. */
export function resolveConsoleUrl(configured: ConsoleOptions | undefined): string | undefined {
  return configured?.url === undefined ? undefined : consoleOrigin(configured.url)
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
  const url: unknown = Reflect.get(value, "url")
  if (url !== undefined && consoleOrigin(url) === undefined) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: `[vitehub] console.url must be the https:// origin of a ViteHub Console without a path, such as "https://console.example.com", or http://localhost for a Console on this computer.` })
  }
  // SAFETY: `auth`, `impersonation`, `sections`, and `url` are checked above. The other fields keep their documented types and are checked where they are read.
  return value as ConsoleOptions
}

export interface ConsoleVitePluginOptions {
  /** The `name` option of `vitehub()`, which `project.get` reports. */
  name?: string
  /** The host that `vitehub()` builds for, which `project.get` reports with the build. */
  host?: NonNullable<ConsoleAppModuleOptions["target"]>["host"]
  /** Serve the development RPC and Setup without the full Console. */
  rpcOnly?: boolean
  /**
   * The `comments` option of `vitehub()`. With the Comments pill, from this option or `server/comments.ts`, the app
   * serves Site access at `/_vitehub/site`, sends `/_vitehub` to the page of the app with the pill, and has the `site`
   * section. Without it, `/_vitehub` opens the ViteHub Console.
   */
  comments?: ConsoleSiteComments
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

/** Whether the server environments of the Agent invocation Console closed. A closed one writes no generated app module. */
export interface ConsoleInvocationRootState {
  closed?: boolean
}

function configureConsoleNitroRoutes(
  nitro: ConsoleNitroConfig,
  baseURL: string,
  siteAccess: boolean,
  app: string | undefined,
): ReturnType<typeof createNitroServerKit> {
  // Nitro serves its routes below its own `baseURL`, so the routes get only the part of the Vite base that Nitro does not
  // add. Without a Nitro `baseURL`, this is the whole Vite base.
  const mount = viteHubPageToolsBase({ base: baseURL, nitro }).mount
  const kit = createNitroServerKit({ ...nitro, handlers: Array.isArray(nitro.handlers) ? [...nitro.handlers] : [] })
  addConsoleRpcHandler(kit.config, consoleRuntimeRoot, mount, { siteAccess })
  if (app) kit.config.alias = { ...kit.config.alias instanceof Object ? kit.config.alias : {}, [consoleAppModuleId]: app }
  return kit
}

/**
 * The variables that a deployed Console reads: a `VITEHUB_CONSOLE_KEY_<NAME>` public key for each linked Console.
 * Without `console`, it reads none.
 */
export function consoleDeploymentEnv(configured: ConsoleOptions | undefined): DeploymentEnvEntry[] {
  if (!configured) return []
  return [{ names: [], prefix: "VITEHUB_CONSOLE_KEY_", required: true, secret: false, hasDefault: false, owners: ["console"] }]
}

/** Reject a production build that takes Console calls without a signature. */
export function assertConsoleProductionAuth(configured: ConsoleOptions): void {
  if (configured.auth !== false) return
  throw viteHubErrorDiagnostics.VITE_HUB_B0022({ message: "[vitehub] console.auth false is for development. Remove console.auth so the app takes only signed calls, and set the VITEHUB_CONSOLE_KEY_<NAME> line that the ViteHub Console shows when you link the app (or that vitehub secret console-key prints)." })
}

/** Resolve the `console.authorize` file. A configured path must exist. */
export function resolveConsoleAuthorizeFile(root: string, authorize: unknown): string | undefined {
  if (authorize === undefined) return
  if (typeof authorize !== "string" || !authorize.trim()) throw viteHubErrorDiagnostics.VITE_HUB_CONSOLE_AUTHORIZE_PATH_INVALID()
  const file = resolve(root, authorize)
  if (!existsSync(file)) throw viteHubErrorDiagnostics.VITE_HUB_CONSOLE_AUTHORIZE_FILE_MISSING({ file })
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
    throw viteHubErrorDiagnostics.VITE_HUB_B0005({ message: "[vitehub] console.impersonation needs app Auth. Add server/auth.ts with Better Auth's admin plugin, or remove console.impersonation." })
  }
}

export function consoleVitePlugin(options: ConsoleVitePluginOptions): Plugin {
  let sections = options.sections ?? []
  let blobStores = options.blobStores ?? []
  let generatedApp: string | undefined
  let databaseDiscoveryRoot: string | undefined
  let projectRoot: string | undefined
  let rateLimitDiscoveryRoot: string | undefined
  let rateLimitScanDirs: string[] | undefined
  let root: string | undefined
  let serverDirs: string[] | undefined
  let scheduleDiscoveryRoot: string | undefined
  let workspaceDiscoveryRoot: string | undefined
  let resolvedPlugins: readonly Plugin[] | undefined
  let cliDiscovery = false
  let development = false
  let nitroVersion: string | undefined
  let invoke = false
  let resolvedConsoleConfiguration: ConsoleOptions | undefined
  const consoleBuildCatalogs = new Map<string, Awaited<ReturnType<typeof discoverConsoleBuildCatalog>>>()
  let baseURL = "/"
  let applicationBase = "/"
  const siteAccess = () => projectRoot !== undefined && resolveConsoleSiteAccess(options.comments, { projectRoot, serverDirs })

  function consoleAccess(): ConsoleAccessBuild | undefined {
    if (!resolvedConsoleConfiguration || !root) return
    return resolveConsoleAccessBuild(resolvedConsoleConfiguration, { root })
  }

  /** The options of the generated Console app module, read from the current state when it is written. */
  function consoleAppModuleOptions(): Omit<ConsoleAppModuleOptions, "catalog" | "file" | "projectRoot"> {
    return {
      access: consoleAccess(),
      active: () => !options.invocationRootState?.closed,
      blobStores,
      development,
      invoke,
      name: options.name,
      operationSections: options.operationSections,
      runtimeCapabilityImports: resolveConsoleRuntimeCapabilityImports(options.runtimeCapabilityImports, resolvedPlugins),
      sections,
      ...(development ? {} : { target: { ...(options.host ? { host: options.host } : {}), framework: { name: "nitro" as const, ...(nitroVersion ? { version: nitroVersion } : {}) } } }),
      navigationSections: options.rpcOnly ? sections.filter(section => section === "setup") : undefined,
      ...(options.rpcOnly || !siteAccess() ? {} : { site: true }),
    }
  }

  const refreshConsoleCatalog = serializeConsoleRefresh(async () => {
    if (!generatedApp || !projectRoot || !root) return
    const catalog = await discoverConsoleBuildCatalog({ contentImportBase: options.contentImportBase, databaseDiscoveryRoot, databaseImplicitDefault: true, discoveryRoot: root, plugins: resolvedPlugins, projectRoot, rateLimitDiscoveryRoot, rateLimitScanDirs, sandboxTaskDiscoveryRoot: root, scheduleDiscoveryRoot, sections, serverDirs, workspaceDiscoveryRoot })
    consoleBuildCatalogs.set(projectRoot, catalog)
    await writeConsoleAppModule({ ...consoleAppModuleOptions(), catalog, file: generatedApp, projectRoot })
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
        const framework = nitro.options.framework
        nitroVersion = framework?.name === "nitro" ? framework.version : undefined
      },
    },
    resolveId: {
      order: "pre",
      filter: { id: /^#vitehub\/console\/app$/ },
      handler() {
        return generatedApp
      },
    },
    transform: {
      filter: consoleOperationFeaturesFilter,
      handler(code) {
        const catalog = projectRoot ? consoleBuildCatalogs.get(projectRoot) : undefined
        const documents = development ? consoleDocumentEditorSectionIds.length > 0 : catalog ? consoleAppModuleHasDocumentEditors({ ...consoleAppModuleOptions(), catalog }) : undefined
        const transformed = transformConsoleOperationFeatures(code, options.operationSections ?? sections, documents)
        return transformed === undefined ? undefined : { code: transformed, map: null }
      },
    },
    async config(config, environment) {
      development = environment.command === "serve"
      nitroVersion = undefined
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
        [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
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
      generatedApp = resolveGeneratedConsoleApp(projectRoot, development)
      if (!cliDiscovery) {
        const resolvedOnlySections = new Set<ConsoleSectionId>(["databases", "sandbox-tasks", "workflows", "workspaces"])
        const initialSections = sections.filter(section => !resolvedOnlySections.has(section))
        const catalog = await discoverConsoleBuildCatalog({ contentImportBase: options.contentImportBase, databaseDiscoveryRoot, databaseImplicitDefault: true, discoveryRoot: root, projectRoot, rateLimitDiscoveryRoot, rateLimitScanDirs, sandboxTaskDiscoveryRoot: root, scheduleDiscoveryRoot, sections: initialSections, serverDirs, workspaceDiscoveryRoot })
        consoleBuildCatalogs.set(projectRoot, catalog)
        await writeConsoleAppModule({ ...consoleAppModuleOptions(), catalog, file: generatedApp, projectRoot })
      }
      // SAFETY: Nitro extends Vite's user config with this documented top-level configuration object.
      const consoleConfig = viteConfig as typeof viteConfig & { nitro?: ConsoleNitroConfig }
      const nitro: ConsoleNitroConfig = consoleConfig.nitro
        ? { ...consoleConfig.nitro }
        : {}
      const nitroConfig = { ...configureConsoleNitroRoutes(nitro, applicationBase, siteAccess(), generatedApp).config }
      consoleConfig.nitro = nitroConfig
      const consoleUrl = resolveConsoleUrl(configured)
      if (!consoleUrl) return
      const define = JSON.stringify(consoleUrl)
      // Nuxt can build Nitro outside Vite. That build reads Nitro `replace`, not Vite `define`.
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT] === true) {
        const replace = nitroConfig.replace instanceof Object ? nitroConfig.replace : {}
        nitroConfig.replace = { ...replace, __VITEHUB_CONSOLE_URL__: define }
      }
      return { define: { __VITEHUB_CONSOLE_URL__: define } }
    },
    async configResolved(config) {
      root = config.root
      resolvedPlugins = config.plugins
      baseURL = viteHubPageToolsBase(config).base || "/"
      applicationBase = baseURL
      projectRoot ||= resolveViteHubProjectRoot(config.root)
      generatedApp ||= resolveGeneratedConsoleApp(projectRoot, development)
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
      generatedApp = resolveGeneratedConsoleApp(projectRoot, development)
      // SAFETY: VITEHUB_SERVER_DIRS is ViteHub-owned config state populated with string paths.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      viteConfig.nitro = { ...configureConsoleNitroRoutes(viteConfig.nitro ??= {}, viteHubPageToolsBase(config).base, siteAccess(), generatedApp).config }
      if (!cliDiscovery) await refreshConsoleCatalog()
    },
    configureServer(server) {
      publishViteHubDevServer(server)
      // Nitro's WebSocket upgrades skip its dev handlers. The listener signs only after the Nitro module made a key.
      if (server.httpServer) addViteHubDevPeerUpgradeSigner(server.httpServer)
      if (resolvedConsoleConfiguration && server.httpServer) {
        const http = server.httpServer
        http.once("listening", () => {
          const notice = consoleDevAccessNotice(consoleAccess()?.mode, http.address())
          if (notice) server.config.logger.warn(notice)
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
    load: async () => (await loadConsoleOperations()).filter(operation => sections().includes("databases") || !operation.name.startsWith("databases.")),
    module: "vite-hub/console/server",
    runtime: false,
  }]
}

/**
 * Keeps `vite-hub` in the server environments of an app with Agents, so the Console and the app read one Agent
 * Invocation journal, and records when those environments close, so a closed server writes no generated app module.
 */
export function consoleInvocationRootPlugin(state: ConsoleInvocationRootState = {}): Plugin {
  const activeEnvironments = new Set<Environment>()

  function closeEnvironment(environment: Environment | undefined): void {
    if (environment) activeEnvironments.delete(environment)
    if (activeEnvironments.size === 0) state.closed = true
  }

  return {
    name: "vite-hub/console-invocation-root",
    applyToEnvironment: environment => environment.config.consumer === "server",
    perEnvironmentStartEndDuringDev: true,
    configEnvironment(_name, config) {
      if (config.consumer !== "server") return
      return { resolve: { noExternal: ["vite-hub"] } }
    },
    closeBundle() {
      closeEnvironment(this.environment)
    },
    buildEnd(error) {
      if (error) closeEnvironment(this.environment)
    },
    buildStart() {
      if (this.environment) activeEnvironments.add(this.environment)
      state.closed = false
    },
    resolveId: {
      filter: { id: /^vite-hub\/agent$/ },
      async handler(source, importer, options) {
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
        if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(source)} for the Agent invocation console.`)
        return { ...resolved, external: false }
      },
    },
  }
}
