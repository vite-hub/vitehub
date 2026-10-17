import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import type { AgentInvocationRetentionOptions, AgentInvocationsOptions } from "@vite-hub/agent/server"
import type { AuthModuleOptions, ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { Environment, Plugin } from "vite"
import { isConsoleConnectionsEnabled, type ConsoleSectionId } from "./runtime/sections.ts"

import { discoverConsoleBuildCatalog } from "./build.ts"
import { consoleConnectionsActorId, writeConsoleConnectionsActor, registeredConsoleAuthMode, resolveConsoleAuthConfig, writeConsoleAuthHandlers, type ConsoleAuthConfig, type ConsoleAuthHandlers } from "./auth-build.ts"
import { writeConsoleNitroPlugin, type ConsoleAccessBuild } from "./plugin.ts"
import { serializeConsoleRefresh } from "./refresh.ts"
import { createConsoleCliNamespace } from "./cli.ts"
import { consoleFixtureEnvironmentVariable, consoleFixtureRevision, readConsoleFixture } from "./fixture.ts"
import { bindConsoleInvocationsIdentity, createConsoleInvocationsIdentity, releaseConsoleInvocationsBinding } from "./internal.ts"
import { addConsoleRpcHandler } from "./nitro.ts"
import { consoleOpenAccessWarning } from "./runtime/server/access.ts"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"
import { resolveConsoleJournal, type ConsoleJournal } from "../storage-config.ts"

const frameworkAgentSpecifier = "vite-hub/agent"
function resolveConsoleRuntimeRoot(): string {
  const root = [
    fileURLToPath(new URL("./runtime", import.meta.url)),
    fileURLToPath(new URL("./console/runtime", import.meta.url)),
  ].find(root => ["page.get.ts", "page.get.js"].some(file => existsSync(join(root, "server", file))))
  if (!root) throw viteHubErrorDiagnostics.VITE_HUB_B0001({ message: "[vitehub] Could not locate the packaged Console runtime." })
  return root
}
const consoleRuntimeRoot = resolveConsoleRuntimeRoot()
const consolePublicRoot = join(consoleRuntimeRoot, "public/console")
const generatedConsolePlugin = ".vitehub/nitro/console/plugin.mjs"

export function resolveGeneratedConsolePlugin(
  root: string,
  fixture: string | undefined,
  state: ConsoleInvocationRootState | undefined,
): string {
  if (!fixture) return resolve(root, generatedConsolePlugin)
  const binding = state?.binding ?? randomUUID()
  if (state) state.binding = binding
  return resolve(root, ".vitehub/nitro/console", `plugin-${binding}.mjs`)
}

type ConsoleNitroConfig = {
  handlers?: Array<{ handler: string, method?: string, route: string }>
  plugins?: string[]
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean, maxAge?: number }>
  [key: string]: unknown
}

/**
 * The Console options. `auth` is required in every environment, so the Console is never open by accident.
 * - `auth: false`: no sign-in. A production build and a production server log a warning.
 * - `auth: "app"`: the app Auth Session. The app Auth access routes or `authorize` decide who may use the Console.
 * - `auth: { ... }`: Console Auth, with a server file, inline GitHub, or `{ provider: "cloudflare-access" }`.
 */
export interface ConsoleOptions {
  auth?: false | "app" | ConsoleAuthConfig
  /** @deprecated Use `auth`. Kept for older integrations. */
  access?: "auth" | "local" | "open"
  /** @deprecated Use `auth` and `authorize`. */
  exposure?: "host-managed" | "open"
  /**
   * Server file that default-exports `defineConsoleAuthorize()`. Every Console data route calls it after the `auth` check.
   * It returns `true`, `false`, a `Response`, or `{ sections }` to allow only some Console sections.
   */
  authorize?: string
  databaseUrl?: string
  /** Let the Console start Agent Invocations and run manual Schedules. Defaults to `true` in development and `false` in production builds. */
  invoke?: boolean
  observations?: AgentInvocationsOptions["observations"]
  retention?: AgentInvocationRetentionOptions
}

/**
 * Validate the `console` option at the ViteHub boundary. Every environment must choose Console access explicitly.
 * Returns `undefined` when the Console is off.
 */
export function resolveConsoleOptions(value: unknown): ConsoleOptions | undefined {
  if (value === undefined || value === false) return undefined
  if (value === true) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0003({ message: '[vitehub] console: true is not supported. Choose who can open the Console: console: { auth: false } for no sign-in, or console: { auth: "app" } to use your app Auth.' })
  }
  if (!(value instanceof Object) || Array.isArray(value)) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: '[vitehub] console.auth is required. Set console: { auth: false } for no sign-in, console: { auth: "app" } to use your app Auth, or console: { auth: { ... } } for Console Auth.' })
  }
  const legacy = value as { access?: string, exposure?: string, auth?: unknown }
  if (legacy.access !== undefined && legacy.access !== "auth" && legacy.access !== "local" && legacy.access !== "open") {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: '[vitehub] console.access must be "auth", "local", or "open". Use console.auth instead.' })
  }
  if (legacy.exposure !== undefined && legacy.exposure !== "host-managed" && legacy.exposure !== "open") {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: '[vitehub] console.exposure must be "host-managed" or "open". Use console.auth instead.' })
  }
  if (!("auth" in value) && (legacy.access !== undefined || legacy.exposure !== undefined)) {
    // Host-managed exposure delegates authorization to the host and must not
    // trigger the app-auth discovery/assertion path during plugin setup.
    const auth = legacy.exposure === "host-managed" ? false : legacy.access === "auth" ? "app" : legacy.access === "local" ? false : false
    return { ...value, auth } as ConsoleOptions
  }
  if (!("auth" in value)) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: '[vitehub] console.auth is required. Set console: { auth: false } for no sign-in, console: { auth: "app" } to use your app Auth, or console: { auth: { ... } } for Console Auth.' })
  }
  const auth = value.auth
  if (auth !== false && auth !== "app" && (!(auth instanceof Object) || Array.isArray(auth))) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: '[vitehub] console.auth must be false, "app", or a Console Auth config object.' })
  }
  // SAFETY: `auth` is checked above. The other fields keep their documented types and are checked where they are read.
  return value as ConsoleOptions
}

/** Return the Console Auth config of the options, or `undefined` for `auth: false` and `auth: "app"`. */
export function consoleAuthConfig(options: ConsoleOptions | false | undefined): ConsoleAuthConfig | undefined {
  return options && options.auth !== false && options.auth !== "app" ? options.auth : undefined
}

export interface ConsoleVitePluginOptions {
  blobStores?: readonly string[]
  console?: ConsoleOptions
  connections?: unknown
  runtimeCapabilityImports?: Record<string, false | string>
  /** D1 binding that stores the journal in production Cloudflare builds. */
  resolveD1Binding?: (root: string, serverDirs: string[] | undefined) => string | undefined
  databaseUrl?: string
  databaseDiscoveryRoot?: string
  kvStores?: readonly string[]
  preset?: string
  rateLimitDiscoveryRoot?: string
  rateLimitScanDirs?: string[]
  resolveAuthConfig?: (root: string, serverDirs: string[] | undefined, auth: AuthModuleOptions | undefined) => ResolvedAuthViteConfig | undefined
  resolveBlobStores?: (blob: unknown) => readonly string[] | false
  resolveKVStores?: (kv: unknown) => readonly string[] | false
  invocationRootState?: ConsoleInvocationRootState
  sections?: readonly ConsoleSectionId[]
  scheduleDiscoveryRoot?: string
  workspaceDiscoveryRoot?: string
}

export interface ConsoleInvocationRootState {
  binding?: string
  closed?: boolean
  fixtureLifecycle?: {
    close: () => Promise<void>
    reopen: () => Promise<void>
  }
  identity?: string
  projectRoot?: string
}

export function createConsoleInvocationRootState(): ConsoleInvocationRootState {
  return { binding: randomUUID() }
}

export function configureConsoleFixtureLifecycle(
  state: ConsoleInvocationRootState,
  generatedPlugin: string,
  refresh: () => Promise<void>,
): void {
  state.fixtureLifecycle = {
    async close() {
      await refresh().catch(() => undefined)
      await rm(generatedPlugin, { force: true })
    },
    reopen: refresh,
  }
}

export async function closeConsoleInvocationRootState(state: ConsoleInvocationRootState): Promise<void> {
  if (state.closed) return
  state.closed = true
  if (state.binding) releaseConsoleInvocationsBinding(state.binding)
  await state.fixtureLifecycle?.close()
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

function consoleAccessTargets(base: string | undefined, sections?: readonly ConsoleSectionId[]): Array<{ method?: string; route: string }> {
  return [
    { route: consoleMountPath(base, "/_vitehub/**") },
    { method: "GET", route: consoleMountPath(base, "/api/_vitehub/console/status") },
    ...(sections?.includes("agents") && sections.includes("usage")
      ? [{ method: "GET", route: consoleMountPath(base, "/api/_vitehub/console/usage") }]
      : []),
  ]
}

function consoleMountBase(base: string | undefined): string {
  if (!base || base === "./") return ""
  let pathname = base
  if (/^https?:\/\//.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname
    }
    catch {
      return ""
    }
  }
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return ""
  return pathname.replace(/\/+$/, "")
}

function consoleMountPath(base: string | undefined, path: string): string {
  return `${consoleMountBase(base)}${path}`
}

function configureConsoleNitroRoutes(
  nitro: ConsoleNitroConfig,
  baseURL: string,
  sections: readonly ConsoleSectionId[],
  consoleAuthHandlers: ConsoleAuthHandlers | undefined,
  previousConsoleAuthHandlers?: ConsoleAuthHandlers,
): { kit: ReturnType<typeof createNitroServerKit>, publicAssets: NonNullable<ConsoleNitroConfig["publicAssets"]> } {
  const runtimeHandlers = new Set([
    join(consoleRuntimeRoot, "server/agents.get.js"),
    join(consoleRuntimeRoot, "server/blob.get.js"),
    join(consoleRuntimeRoot, "server/client.get.js"),
    join(consoleRuntimeRoot, "server/database.get.js"),
    join(consoleRuntimeRoot, "server/definitions.get.js"),
    join(consoleRuntimeRoot, "server/invocation.get.js"),
    join(consoleRuntimeRoot, "server/invocation-capabilities.get.js"),
    join(consoleRuntimeRoot, "server/invocations.get.js"),
    join(consoleRuntimeRoot, "server/kv.get.js"),
    join(consoleRuntimeRoot, "server/page.get.js"),
    join(consoleRuntimeRoot, "server/search.get.js"),
    join(consoleRuntimeRoot, "server/sections.get.js"),
    join(consoleRuntimeRoot, "server/status.get.js"),
    join(consoleRuntimeRoot, "server/usage.get.js"),
  ])
  const authHandlers = new Set([
    consoleAuthHandlers?.client,
    consoleAuthHandlers?.middleware,
    consoleAuthHandlers?.route,
    consoleAuthHandlers?.signIn,
    previousConsoleAuthHandlers?.client,
    previousConsoleAuthHandlers?.middleware,
    previousConsoleAuthHandlers?.route,
    previousConsoleAuthHandlers?.signIn,
  ].filter((handler): handler is string => handler !== undefined))
  const handlers = Array.isArray(nitro.handlers)
    ? nitro.handlers.filter(handler => !runtimeHandlers.has(handler?.handler) && !authHandlers.has(handler?.handler))
    : []
  const kit = createNitroServerKit({ ...nitro, handlers })
  for (const handler of [
    { handler: join(consoleRuntimeRoot, "server/status.get.js"), route: consoleMountPath(baseURL, "/api/_vitehub/console/status"), method: "get" },
    // The Usage section reads the Agent invocation journal, which exists only with the Agents section.
    ...(sections.includes("agents") && sections.includes("usage") ? [{ handler: join(consoleRuntimeRoot, "server/usage.get.js"), route: consoleMountPath(baseURL, "/api/_vitehub/console/usage"), method: "get" }] : []),
    ...(consoleAuthHandlers?.signIn ? [{ handler: consoleAuthHandlers.signIn, route: consoleMountPath(baseURL, "/_vitehub/sign-in"), method: "get" }] : []),
    { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: consoleMountPath(baseURL, "/_vitehub") },
    { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: consoleMountPath(baseURL, "/_vitehub/**") },
  ]) kit.addHandler(handler)
  kit.addHandler({
    handler: consoleAuthHandlers?.client ?? join(consoleRuntimeRoot, "server/client.get.js"),
    route: consoleMountPath(baseURL, "/api/_vitehub/console/client.js"),
    method: "get",
  })
  if (consoleAuthHandlers?.route) kit.addHandler({ handler: consoleAuthHandlers.route, route: consoleMountPath(baseURL, "/api/_vitehub/console/auth/**") })
  if (consoleAuthHandlers) kit.addHandler({ handler: consoleAuthHandlers.middleware, middleware: true, route: "/**" })
  addConsoleRpcHandler(kit.config, consoleRuntimeRoot, baseURL)
  const consoleAssetsBase = consoleMountPath(baseURL, "/_vitehub/assets")
  const userPublicAssets = Array.isArray(nitro.publicAssets)
    ? nitro.publicAssets.filter(asset => asset?.dir !== consolePublicRoot)
    : []
  const publicAssets = [{
    baseURL: consoleAssetsBase,
    dir: consolePublicRoot,
    fallthrough: false,
    // Every Console asset name contains a content hash.
    maxAge: 60 * 60 * 24 * 365,
  }, ...userPublicAssets]
  return { kit, publicAssets }
}

function authRouteProtects(
  route: ResolvedAuthViteConfig["access"]["routes"][number],
  target: { method?: string; route: string },
): boolean {
  if (!route.authorize || (route.method && route.method.toUpperCase() !== target.method)) return false
  const recursive = route.route.endsWith("/**")
  const routeBase = recursive ? route.route.slice(0, -3) : route.route
  const targetRecursive = target.route.endsWith("/**")
  // An exact Auth rule protects only its exact endpoint. It cannot satisfy a recursive Console namespace target.
  if (targetRecursive && !recursive) return false
  const targetBase = targetRecursive ? target.route.slice(0, -3) : target.route
  return targetBase === routeBase || (recursive && targetBase.startsWith(`${routeBase}/`))
}

/**
 * The warning that a production build logs for `auth: false`, or `undefined` when there is nothing to warn about.
 * Without `authorize`, anyone can use the Console. On Cloudflare, `authorize` alone does not verify the Cloudflare Access token.
 */
export function consoleOpenAccessBuildWarning(configured: ConsoleOptions, preset: string | undefined): string | undefined {
  if (configured.auth !== false) return
  if (!configured.authorize) return consoleOpenAccessWarning
  if (preset === "cloudflare") return '[vitehub] console: { auth: false } trusts console.authorize to check every request. On Cloudflare, use console: { auth: { provider: "cloudflare-access" } } so the Worker verifies the Cloudflare Access token.'
}

/** Resolve the `console.authorize` file. A configured path must exist. */
export function resolveConsoleAuthorizeFile(root: string, authorize: unknown): string | undefined {
  if (authorize === undefined) return
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- console.authorize crosses the open Vite config boundary.
  if (typeof authorize !== "string" || !authorize.trim()) throw new TypeError("[vitehub] console.authorize must be a path to a server file.")
  const file = resolve(root, authorize)
  if (!existsSync(file)) throw new TypeError(`[vitehub] console.authorize file does not exist: ${file}`)
  return file
}

function consoleAppAuthRouteIndexes(auth: ResolvedAuthViteConfig, base: string | undefined, sections?: readonly ConsoleSectionId[]): Array<{ authorize: boolean, index: number, method?: string, route: string }> {
  const targets = consoleAccessTargets(base, sections)
  return auth.access.routes.flatMap((route, index) => targets.some(target => authRouteProtects(route, target) || route.route.startsWith(target.route.replace(/\/\*\*$/, "")))
    ? [{ authorize: route.authorize === true, index, method: route.method?.toUpperCase(), route: route.route }]
    : [])
}

/**
 * Resolve the access policy that generated output installs for every Console data route.
 * - `auth: false` is open. Cloudflare Access in development is open too, because development has no Access edge.
 * - Console Auth checks its Session or Cloudflare Access token with the generated middleware module.
 * - `auth: "app"` checks the app Auth Session and the access routes that protect the Console.
 * - `authorize` runs after any of these checks.
 */
export function resolveConsoleAccessBuild(
  configured: ConsoleOptions,
  options: { appAuth?: ResolvedAuthViteConfig, base?: string, handlers?: Pick<ConsoleAuthHandlers, "auth" | "middleware">, root: string, sections?: readonly ConsoleSectionId[] },
): ConsoleAccessBuild {
  const authorize = resolveConsoleAuthorizeFile(options.root, configured.authorize)
  const withAuthorize = (access: ConsoleAccessBuild): ConsoleAccessBuild => authorize ? { ...access, authorize } : access
  if (configured.exposure === "host-managed") return withAuthorize({ mode: "host-managed" } as ConsoleAccessBuild)
  if (configured.access === "local") return withAuthorize({ mode: "local" } as ConsoleAccessBuild)
  if (configured.auth === false || configured.auth === undefined) return withAuthorize({ mode: "open" })
  if (configured.auth === "app") {
    return withAuthorize(options.appAuth
      ? { mode: "auth", check: { appRoutes: consoleAppAuthRouteIndexes(options.appAuth, options.base, options.sections) } }
      : { mode: "auth" })
  }
  return withAuthorize(options.handlers
    ? { mode: options.handlers.auth === true ? "auth" : "cloudflare-access", check: { module: options.handlers.middleware } }
    : { mode: "open" })
}

/**
 * Check the Console access choice in every environment.
 * `auth: "app"` needs a discovered Auth Definition, and either `console.authorize` or app Auth access routes
 * with an `authorize` callback for every Console route.
 */
export function assertConsoleAccess(
  configured: ConsoleOptions,
  options: {
    auth?: ResolvedAuthViteConfig
    base?: string
    sections?: readonly ConsoleSectionId[]
  },
): void {
  if (configured.auth !== "app") return
  if (!options.auth) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0005({ message: '[vitehub] console: { auth: "app" } requires a discovered ViteHub Auth Definition. Set auth: true and add server/auth.ts, or use console: { auth: false }.' })
  }
  if (configured.authorize) return
  const accessRoutes = consoleAccessTargets(options.base, options.sections)
  const missing = accessRoutes.filter(target => !options.auth?.access.routes.some(route => authRouteProtects(route, target)))
  if (missing.length) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0006({ message: `[vitehub] console: { auth: "app" } needs console.authorize, or app Auth access routes with an authorize callback for ${missing.map(target => target.route).join(" and ")}.` })
  }
}

/** Validate legacy production access settings used by older generated integrations. */
export function assertConsoleProductionAccess(configured: ConsoleOptions, options: { auth?: ResolvedAuthViteConfig, base?: string, development?: boolean, sections?: readonly ConsoleSectionId[] }): void {
  if (options.development) return
  const normalized = resolveConsoleOptions(configured)
  if (!normalized) return
  if (normalized.exposure === "host-managed" && !normalized.authorize) throw new TypeError("console.authorize is required for host-managed exposure")
  if ((normalized.auth === "app" || normalized.access === "auth") && options.auth) assertConsoleAccess({ ...normalized, auth: "app" }, options)
}

export function generatedConsolePluginRegistration(value: string): boolean {
  const normalized = value.replaceAll("\\", "/")
  return normalized === generatedConsolePlugin
    || /\/\.vitehub\/nitro\/console\/plugin(?:-[^/]+)?\.mjs$/.test(normalized)
}

function consoleD1JournalMessage(binding: string): string {
  return `[vitehub] Console journal: D1 binding ${binding}, table vitehub_agent_invocations. The journal creates the table on first use.`
}

export function consoleVitePlugin(options: ConsoleVitePluginOptions): Plugin {
  let sections = options.sections ?? []
  let kvStores = options.kvStores ?? []
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
  let fixture: string | undefined
  let cliDiscovery = false
  let invoke = false
  let journal: ConsoleJournal | undefined
  let observations: AgentInvocationsOptions["observations"]
  let retention: AgentInvocationRetentionOptions | undefined
  let consoleAuthHandlers: ConsoleAuthHandlers | undefined
  let consoleAuthMode: true | "cloudflare-access" | false = false
  let resolvedConsoleConfiguration: ConsoleOptions | undefined
  let resolvedAppAuth: ResolvedAuthViteConfig | undefined
  let refreshConsoleAuthClient: (() => Promise<void>) | undefined
  let openAccessBuildWarning: string | undefined
  let baseURL = "/"

  function consoleAccess(): ConsoleAccessBuild | undefined {
    if (!resolvedConsoleConfiguration || !root) return
    return resolveConsoleAccessBuild(resolvedConsoleConfiguration, { appAuth: resolvedAppAuth, base: baseURL, handlers: consoleAuthHandlers, root, sections })
  }

  const refreshConsoleCatalog = serializeConsoleRefresh(async () => {
    if (!generatedPlugin || !projectRoot || !root) return
    const catalog = await discoverConsoleBuildCatalog({ databaseDiscoveryRoot, databaseImplicitDefault: true, discoveryRoot: root, plugins: resolvedPlugins, projectRoot, rateLimitDiscoveryRoot, rateLimitScanDirs, sandboxDiscoveryRoot: root, scheduleDiscoveryRoot, sections, serverDirs, workspaceDiscoveryRoot })
    const identity = await writeConsoleNitroPlugin(generatedPlugin, projectRoot, sections, catalog.agents, catalog, blobStores, kvStores, fixture, options.invocationRootState?.binding, invoke, observations, () => !options.invocationRootState?.closed, journal, consoleAuthMode, retention, consoleAccess(), options.runtimeCapabilityImports)
    if (options.invocationRootState) updateConsoleInvocationRootState(options.invocationRootState, projectRoot, identity)
  })

  function resolveKVRegistration(kv: unknown): void {
    const resolvedKVStores = options.resolveKVStores?.(kv)
    sections = sections.filter(section => section !== "kv")
    if (resolvedKVStores !== false) sections = [...sections, "kv"]
    kvStores = resolvedKVStores === false ? [] : resolvedKVStores ?? options.kvStores ?? []
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

  const plugin: Plugin & ViteHubCliContributingPlugin = {
    name: "vite-hub/console",
    async config(config, environment) {
      if (options.connections !== undefined && !isConsoleConnectionsEnabled(options, environment.command === "serve")) {
        sections = sections.filter(section => section !== "connections")
      }
      root = resolve(config.root || process.cwd())
      const configured = resolveConsoleOptions(options.console) ?? (environment.command === "serve" ? { auth: false, access: "local" as const } : undefined)
      // The root integration does not add this plugin without Console options, so this only guards direct use.
      if (!configured) throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: '[vitehub] console.auth is required. Set console: { auth: false } for no sign-in, or console: { auth: "app" } to use your app Auth.' })
      resolvedConsoleConfiguration = configured
      // SAFETY: ViteHub Auth and server discovery extend Vite's user config with these documented keys.
      const viteConfig = config as typeof config & {
        [VITEHUB_SERVER_DIRS]?: string[]
        auth?: AuthModuleOptions
        blob?: unknown
        database?: unknown
        kv?: unknown
        queue?: unknown
        rateLimit?: unknown
        sandbox?: unknown
        schedule?: unknown
        workspace?: unknown
        workflow?: unknown
        vitehubCliDiscovery?: true
      }
      resolveBlobRegistration(viteConfig.blob)
      resolveKVRegistration(viteConfig.kv)
      resolveQueueRegistration(viteConfig.queue)
      resolveWorkflowRegistration(viteConfig.workflow ?? options.sections?.includes("workflows"))
      if (Object.hasOwn(viteConfig, "database")) {
        sections = sections.filter(section => section !== "databases")
        if (viteConfig.database) sections = [...sections, "databases"]
      }
      if ("sandbox" in viteConfig) {
        sections = sections.filter(section => section !== "sandboxes")
        if (viteConfig.sandbox) sections = [...sections, "sandboxes"]
      }
      if ("workspace" in viteConfig) {
        sections = sections.filter(section => section !== "workspaces")
        if (viteConfig.workspace) sections = [...sections, "workspaces"]
      }
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Service configuration crosses Vite's open user-config boundary, so validate its runtime shape before reading the optional root.
      const configuredProjectRoot = (value: unknown): string | undefined => value && typeof value === "object" && "projectRoot" in value
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Resolved service configuration crosses Vite's open config boundary, so validate the projectRoot value before resolving it.
        && typeof value.projectRoot === "string"
        ? resolve(root!, value.projectRoot)
        : undefined
      databaseDiscoveryRoot = Object.hasOwn(viteConfig, "database")
        ? configuredProjectRoot(viteConfig.database) ?? configuredProjectRoot({ projectRoot: options.databaseDiscoveryRoot })
        : configuredProjectRoot({ projectRoot: options.databaseDiscoveryRoot })
      rateLimitDiscoveryRoot = configuredProjectRoot(viteConfig.rateLimit) ?? configuredProjectRoot({ projectRoot: options.rateLimitDiscoveryRoot })
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Rate Limit configuration crosses Vite's open user-config boundary, so validate scan directory entries before discovery.
      rateLimitScanDirs = viteConfig.rateLimit && typeof viteConfig.rateLimit === "object" && "scanDirs" in viteConfig.rateLimit && Array.isArray(viteConfig.rateLimit.scanDirs)
        ? viteConfig.rateLimit.scanDirs.filter((value): value is string => typeof value === "string")
        : options.rateLimitScanDirs
      scheduleDiscoveryRoot = configuredProjectRoot(viteConfig.schedule) ?? configuredProjectRoot({ projectRoot: options.scheduleDiscoveryRoot })
      workspaceDiscoveryRoot = configuredProjectRoot(viteConfig.workspace) ?? configuredProjectRoot({ projectRoot: options.workspaceDiscoveryRoot })
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      cliDiscovery = viteConfig.vitehubCliDiscovery === true
      const appAuth = configured.auth === "app"
        ? options.resolveAuthConfig?.(root, viteConfig[VITEHUB_SERVER_DIRS], viteConfig.auth)
        : undefined
      resolvedAppAuth = appAuth
      baseURL = config.base ?? "/"
      assertConsoleAccess(configured, { auth: appAuth, base: baseURL, sections })
      assertConsoleProductionAccess(configured, {
        auth: appAuth,
        base: baseURL,
        development: environment.command !== "build",
        sections,
      })
      openAccessBuildWarning = environment.command === "build" && !cliDiscovery ? consoleOpenAccessBuildWarning(configured, options.preset) : undefined
      const configuredConsoleAuth = consoleAuthConfig(configured)
      const resolvedConsoleAuth = configuredConsoleAuth ? resolveConsoleAuthConfig(root, configuredConsoleAuth, options.preset) : undefined
      const registeredConsoleAuth = registeredConsoleAuthMode(configuredConsoleAuth, environment.command !== "build") ? resolvedConsoleAuth : undefined
      consoleAuthMode = registeredConsoleAuthMode(configuredConsoleAuth, environment.command !== "build")
      consoleAuthHandlers = registeredConsoleAuth ? await writeConsoleAuthHandlers(root, registeredConsoleAuth, baseURL) : undefined
      refreshConsoleAuthClient = registeredConsoleAuth
        ? serializeConsoleRefresh(async () => { consoleAuthHandlers = await writeConsoleAuthHandlers(root!, registeredConsoleAuth, baseURL) })
        : undefined
      projectRoot = resolveViteHubProjectRoot(root)
      const configuredFixture = viteConfig.vitehubCliDiscovery
        ? undefined
        : process.env[consoleFixtureEnvironmentVariable]
      fixture = undefined
      if (configuredFixture) {
        if (environment.command === "build") {
          throw viteHubErrorDiagnostics.VITE_HUB_B0007({ message: "[vitehub] Console fixture mode is development-only." })
        }
        fixture = resolve(projectRoot, configuredFixture)
        readConsoleFixture(fixture)
      }
      const build = environment.command === "build"
      const configuredDatabaseUrl = configured.databaseUrl ?? options.databaseUrl
      journal = resolveConsoleJournal(configuredDatabaseUrl, build && !configuredDatabaseUrl ? options.resolveD1Binding?.(root, serverDirs) : undefined, build)
      observations = configured.observations
      retention = configured.retention
      invoke = !fixture && (configured.invoke ?? !build)
      generatedPlugin = resolveGeneratedConsolePlugin(projectRoot, fixture, options.invocationRootState)
      if (fixture && options.invocationRootState) {
        configureConsoleFixtureLifecycle(options.invocationRootState, generatedPlugin, refreshConsoleCatalog)
      }
      if (!cliDiscovery && !fixture) {
        const resolvedOnlySections = new Set<ConsoleSectionId>(["databases", "sandboxes", "workflows", "workspaces"])
        const initialSections = sections.filter(section => !resolvedOnlySections.has(section))
        const catalog = await discoverConsoleBuildCatalog({ databaseDiscoveryRoot, databaseImplicitDefault: true, discoveryRoot: root, projectRoot, rateLimitDiscoveryRoot, rateLimitScanDirs, sandboxDiscoveryRoot: root, scheduleDiscoveryRoot, sections: initialSections, serverDirs, workspaceDiscoveryRoot })
        await writeConsoleNitroPlugin(
          generatedPlugin,
          projectRoot,
          sections,
          catalog.agents,
          catalog,
          blobStores,
          kvStores,
          fixture,
          options.invocationRootState?.binding,
          invoke,
          observations,
          () => !options.invocationRootState?.closed,
          journal,
          consoleAuthMode,
          retention,
          consoleAccess(),
          options.runtimeCapabilityImports,
        )
      }
      // SAFETY: Nitro extends Vite's user config with this documented top-level configuration object.
      const consoleConfig = viteConfig as typeof viteConfig & { nitro?: ConsoleNitroConfig }
      const nitro: ConsoleNitroConfig = consoleConfig.nitro
        ? { ...consoleConfig.nitro }
        : {}
      const { kit, publicAssets } = configureConsoleNitroRoutes(nitro, baseURL, sections, consoleAuthHandlers)
      if (Array.isArray(kit.config.plugins)) {
        const plugins = kit.config.plugins.filter(candidate => !generatedConsolePluginRegistration(candidate))
        kit.config.plugins.splice(0, kit.config.plugins.length, ...plugins)
      }
      kit.addPlugin(generatedPlugin)

      const connectionsActor = sections.includes("connections")
        ? await writeConsoleConnectionsActor(root, consoleAuthHandlers?.middleware)
        : undefined
      const alias = kit.config.alias ?? {}
      consoleConfig.nitro = {
        ...kit.config,
        ...(connectionsActor ? { alias: { ...alias, [consoleConnectionsActorId]: connectionsActor } } : {}),
        publicAssets,
      }
    },
    async configResolved(config) {
      if (openAccessBuildWarning) config.logger.warn(openAccessBuildWarning)
      if (journal && "d1Binding" in journal && sections.includes("agents")) config.logger.info(consoleD1JournalMessage(journal.d1Binding))
      root = config.root
      resolvedPlugins = config.plugins
      const previousConsoleAuthHandlers = consoleAuthHandlers
      baseURL = config.base
      if (resolvedConsoleConfiguration) {
        assertConsoleAccess(resolvedConsoleConfiguration, { auth: resolvedAppAuth, base: baseURL, sections })
      }
      await refreshConsoleAuthClient?.()
      projectRoot ||= resolveViteHubProjectRoot(config.root)
      generatedPlugin ||= resolve(projectRoot, generatedConsolePlugin)
      // SAFETY: ViteHub KV and Nitro extend the resolved Vite config with these documented keys.
      const viteConfig = config as typeof config & { blob?: unknown, database?: unknown, kv?: unknown, nitro?: ConsoleNitroConfig, queue?: unknown, rateLimit?: unknown, sandbox?: unknown, schedule?: unknown, workflow?: unknown, workspace?: unknown }
      resolveBlobRegistration(viteConfig.blob)
      resolveKVRegistration(viteConfig.kv)
      resolveQueueRegistration(viteConfig.queue)
      resolveWorkflowRegistration(viteConfig.workflow ?? options.sections?.includes("workflows"))
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Resolved service configuration crosses Vite's open config boundary, so validate its runtime shape before reading the optional root.
      const configuredProjectRoot = (value: unknown): string | undefined => value && typeof value === "object" && "projectRoot" in value
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Resolved service configuration crosses Vite's open config boundary, so validate the projectRoot value before resolving it.
        && typeof value.projectRoot === "string"
        ? resolve(root!, value.projectRoot)
        : undefined
      databaseDiscoveryRoot = Object.hasOwn(viteConfig, "database")
        ? configuredProjectRoot(viteConfig.database)
        : databaseDiscoveryRoot
      if (Object.hasOwn(viteConfig, "database")) {
        sections = sections.filter(section => section !== "databases")
        if (viteConfig.database) sections = [...sections, "databases"]
      }
      rateLimitDiscoveryRoot = "rateLimit" in viteConfig
        ? configuredProjectRoot(viteConfig.rateLimit)
        : rateLimitDiscoveryRoot
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Resolved Rate Limit configuration crosses Vite's open config boundary, so validate scan directory entries before discovery.
      if ("rateLimit" in viteConfig) {
        rateLimitScanDirs = viteConfig.rateLimit && typeof viteConfig.rateLimit === "object" && "scanDirs" in viteConfig.rateLimit && Array.isArray(viteConfig.rateLimit.scanDirs)
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Resolved Rate Limit scan directories cross Vite's open config boundary, so validate each entry before discovery.
          ? viteConfig.rateLimit.scanDirs.filter((value): value is string => typeof value === "string")
          : undefined
      }
      scheduleDiscoveryRoot = configuredProjectRoot(viteConfig.schedule) ?? scheduleDiscoveryRoot
      if ("sandbox" in viteConfig) {
        sections = sections.filter(section => section !== "sandboxes")
        if (viteConfig.sandbox) sections = [...sections, "sandboxes"]
      }
      workspaceDiscoveryRoot = "workspace" in viteConfig
        ? configuredProjectRoot(viteConfig.workspace)
        : workspaceDiscoveryRoot
      if ("workspace" in viteConfig) {
        sections = sections.filter(section => section !== "workspaces")
        if (viteConfig.workspace) sections = [...sections, "workspaces"]
      }
      const nitro = viteConfig.nitro ??= {}
      const { kit, publicAssets } = configureConsoleNitroRoutes(nitro, baseURL, sections, consoleAuthHandlers, previousConsoleAuthHandlers)
      viteConfig.nitro = { ...kit.config, publicAssets }
      generatedPlugin = fixture && generatedPlugin
        ? generatedPlugin
        : resolveGeneratedConsolePlugin(projectRoot, fixture, options.invocationRootState)
      // SAFETY: VITEHUB_SERVER_DIRS is ViteHub-owned config state populated with string paths.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      if (!cliDiscovery && !fixture) await refreshConsoleCatalog()
    },
    buildStart: {
      order: "post",
      async handler() {
        if (!cliDiscovery && fixture) await refreshConsoleCatalog()
      },
    },
    configureServer(server) {
      if (fixture) server.watcher.add(fixture)
      if (consoleAuthHandlers?.clientSources.length) server.watcher.add(consoleAuthHandlers.clientSources)
      const refresh = async (path: string) => {
        try {
          if (consoleAuthHandlers?.clientSources.includes(path)) {
            await refreshConsoleAuthClient?.()
            if (consoleAuthHandlers?.clientSources.length) server.watcher.add(consoleAuthHandlers.clientSources)
          }
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
      cli: {
        namespaces: [createConsoleCliNamespace()],
      },
    },
  }
  return plugin
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
  let fixtureConfigured = false

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
      // SAFETY: ViteHub extends Vite's resolved config with its CLI discovery marker.
      const configuredFixture = (config as typeof config & { vitehubCliDiscovery?: true }).vitehubCliDiscovery
        ? undefined
        : process.env[consoleFixtureEnvironmentVariable]
      const fixture = configuredFixture ? resolve(projectRoot, configuredFixture) : undefined
      fixtureConfigured = Boolean(fixture)
      const revision = fixture ? consoleFixtureRevision(readConsoleFixture(fixture)) : undefined
      const resolvedIdentity = createConsoleInvocationsIdentity(
        projectRoot,
        fixture,
        revision,
        state.binding,
      )
      const activeIdentity = state.identity ?? identity
      if (fixture && activeIdentity && activeIdentity !== resolvedIdentity && state.fixtureLifecycle) {
        await state.fixtureLifecycle.reopen()
      }
      identity = state.identity ?? resolvedIdentity
      if (!fixture) updateConsoleInvocationRootState(state, projectRoot, state.identity ?? identity)
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
        if (state.fixtureLifecycle) await state.fixtureLifecycle.reopen()
        else if (state.binding && state.identity && state.projectRoot) {
          bindConsoleInvocationsIdentity(state.binding, state.identity, state.projectRoot)
        }
      }
      else if (fixtureConfigured && projectRoot && identity) {
        updateConsoleInvocationRootState(state, projectRoot, state.identity ?? identity)
      }
      const resolved = await this.resolve(frameworkAgentSpecifier, undefined, { skipSelf: true })
      if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(frameworkAgentSpecifier)} for the Agent invocation console.`)
      rememberFrameworkAgent(resolved.id)
    },
    async resolveId(source, importer, options) {
      if (source !== frameworkAgentSpecifier) return
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (!resolved) this.error(`[vitehub] Could not resolve ${JSON.stringify(frameworkAgentSpecifier)} for the Agent invocation console.`)
      rememberFrameworkAgent(resolved.id)
      return { ...resolved, external: false }
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
