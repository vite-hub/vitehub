import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { AuthModuleOptions, ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { Environment, Plugin } from "vite"
import type { ConsoleSectionId } from "./runtime/sections.ts"

import { discoverConsoleBuildCatalog } from "./build.ts"
import { writeConsoleNitroPlugin } from "./plugin.ts"
import { serializeConsoleRefresh } from "./refresh.ts"
import { createConsoleCliNamespace } from "./cli.ts"
import { consoleFixtureEnvironmentVariable, consoleFixtureRevision, readConsoleFixture } from "./fixture.ts"
import { bindConsoleInvocationsIdentity, createConsoleInvocationsIdentity, releaseConsoleInvocationsBinding } from "./internal.ts"
import { addConsoleDevframeHandler } from "./nitro.ts"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

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
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean }>
  [key: string]: unknown
}

export type ConsoleOptions =
  | { access: "auth", exposure?: never, invoke?: boolean }
  | { access?: never, exposure: "host-managed", invoke?: never }

interface ConsoleVitePluginOptions {
  blobStores?: readonly string[]
  console?: true | ConsoleOptions
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

const consoleAccessRoutes = [
  { route: "/_vitehub/**" },
  { method: "GET", route: "/api/_vitehub/console/**" },
] satisfies Array<{ method?: string; route: string }>

function authRouteProtects(
  route: ResolvedAuthViteConfig["access"]["routes"][number],
  target: { method?: string; route: string },
): boolean {
  if (!route.authorize || (route.method && route.method.toUpperCase() !== target.method)) return false
  if (!route.route.endsWith("/**")) return false
  const routeBase = route.route.slice(0, -3)
  const targetBase = target.route.slice(0, -3)
  return targetBase === routeBase || targetBase.startsWith(`${routeBase}/`)
}

export function assertConsoleProductionAccess(
  configured: true | ConsoleOptions,
  options: {
    development: boolean
    auth?: ResolvedAuthViteConfig
  },
): void {
  if (configured !== true && configured.exposure === "host-managed" && Reflect.get(configured, "invoke") === true) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0002({ message: '[vitehub] console.invoke requires console: { access: "auth" }.' })
  }
  if (options.development) return
  if (configured === true) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0003({ message: '[vitehub] console: true is development-only. Production Console builds require console: { access: "auth" } or console: { exposure: "host-managed" }.' })
  }
  if (configured.exposure === "host-managed") return
  if (configured.access !== "auth") {
    throw viteHubErrorDiagnostics.VITE_HUB_B0004({ message: '[vitehub] Console production access must use access: "auth" or exposure: "host-managed".' })
  }
  if (!options.auth) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0005({ message: '[vitehub] console: { access: "auth" } requires a discovered ViteHub Auth Definition.' })
  }
  const missing = consoleAccessRoutes.filter(target => !options.auth?.access.routes.some(route => authRouteProtects(route, target)))
  if (missing.length) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0006({ message: `[vitehub] Console Auth access must configure an authorize callback for ${missing.map(target => target.route).join(" and ")}.` })
  }
}

export function discoverConsoleAgentNames(
  root: string,
  serverDirs: string[] = [join(root, "server")],
): string[] {
  return discoverAgentDefinitionEntries(root, serverDirs).map(agent => agent.name)
}

export function generatedConsolePluginRegistration(value: string): boolean {
  const normalized = value.replaceAll("\\", "/")
  return normalized === generatedConsolePlugin
    || /\/\.vitehub\/nitro\/console\/plugin(?:-[^/]+)?\.mjs$/.test(normalized)
}

export function consoleVitePlugin(options: ConsoleVitePluginOptions = {}): Plugin {
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
  let fixture: string | undefined
  let cliDiscovery = false
  let invoke = false

  const refreshConsoleCatalog = serializeConsoleRefresh(async () => {
    if (!generatedPlugin || !projectRoot || !root) return
    const catalog = await discoverConsoleBuildCatalog({ databaseDiscoveryRoot, discoveryRoot: root, projectRoot, rateLimitDiscoveryRoot, rateLimitScanDirs, sandboxDiscoveryRoot: root, scheduleDiscoveryRoot, sections, serverDirs, workspaceDiscoveryRoot })
    const identity = await writeConsoleNitroPlugin(generatedPlugin, projectRoot, sections, catalog.agents, catalog, blobStores, kvStores, fixture, options.invocationRootState?.binding, invoke, () => !options.invocationRootState?.closed)
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
      root = resolve(config.root || process.cwd())
      const configured = options.console ?? true
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
      if ("database" in viteConfig) {
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
      databaseDiscoveryRoot = configuredProjectRoot(viteConfig.database) ?? configuredProjectRoot({ projectRoot: options.databaseDiscoveryRoot })
      rateLimitDiscoveryRoot = configuredProjectRoot(viteConfig.rateLimit) ?? configuredProjectRoot({ projectRoot: options.rateLimitDiscoveryRoot })
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Rate Limit configuration crosses Vite's open user-config boundary, so validate scan directory entries before discovery.
      rateLimitScanDirs = viteConfig.rateLimit && typeof viteConfig.rateLimit === "object" && "scanDirs" in viteConfig.rateLimit && Array.isArray(viteConfig.rateLimit.scanDirs)
        ? viteConfig.rateLimit.scanDirs.filter((value): value is string => typeof value === "string")
        : options.rateLimitScanDirs
      scheduleDiscoveryRoot = configuredProjectRoot(viteConfig.schedule) ?? configuredProjectRoot({ projectRoot: options.scheduleDiscoveryRoot })
      workspaceDiscoveryRoot = configuredProjectRoot(viteConfig.workspace) ?? configuredProjectRoot({ projectRoot: options.workspaceDiscoveryRoot })
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      cliDiscovery = viteConfig.vitehubCliDiscovery === true
      assertConsoleProductionAccess(configured, {
        auth: configured !== true && configured.access === "auth"
          ? options.resolveAuthConfig?.(root, viteConfig[VITEHUB_SERVER_DIRS], viteConfig.auth)
          : undefined,
        development: environment.command !== "build",
      })
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
      invoke = !fixture && (configured === true || configured.invoke === true)
      generatedPlugin = resolveGeneratedConsolePlugin(root, fixture, options.invocationRootState)
      if (fixture && options.invocationRootState) {
        configureConsoleFixtureLifecycle(options.invocationRootState, generatedPlugin, refreshConsoleCatalog)
      }
      if (!cliDiscovery && !fixture) {
        const resolvedOnlySections = new Set<ConsoleSectionId>(["databases", "sandboxes", "workflows", "workspaces"])
        const initialSections = sections.filter(section => !resolvedOnlySections.has(section))
        const catalog = await discoverConsoleBuildCatalog({ databaseDiscoveryRoot, discoveryRoot: root, projectRoot, rateLimitDiscoveryRoot, rateLimitScanDirs, sandboxDiscoveryRoot: root, scheduleDiscoveryRoot, sections: initialSections, serverDirs, workspaceDiscoveryRoot })
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
        )
      }
      // SAFETY: Nitro extends Vite's user config with this documented top-level configuration object.
      const consoleConfig = viteConfig as typeof viteConfig & { nitro?: ConsoleNitroConfig }
      const nitro: ConsoleNitroConfig = consoleConfig.nitro
        ? { ...consoleConfig.nitro }
        : {}
      const handlers = Array.isArray(nitro.handlers)
        ? nitro.handlers.filter(handler => ![
                join(consoleRuntimeRoot, "server/blob.get.js"),
                join(consoleRuntimeRoot, "server/database.get.js"),
                join(consoleRuntimeRoot, "server/definitions.get.js"),
                join(consoleRuntimeRoot, "server/invocation.get.js"),
                join(consoleRuntimeRoot, "server/invocation-capabilities.get.js"),
                join(consoleRuntimeRoot, "server/invocations.get.js"),
                join(consoleRuntimeRoot, "server/kv.get.js"),
                join(consoleRuntimeRoot, "server/agents.get.js"),
                join(consoleRuntimeRoot, "server/sections.get.js"),
                join(consoleRuntimeRoot, "server/search.get.js"),
                join(consoleRuntimeRoot, "server/usage.get.js"),
                join(consoleRuntimeRoot, "server/status.get.js"),
                join(consoleRuntimeRoot, "server/page.get.js"),
              ].includes(handler?.handler),
          )
        : []
      handlers.push(
        { handler: join(consoleRuntimeRoot, "server/status.get.js"), route: "/api/_vitehub/console/status", method: "get" },
        { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: "/_vitehub" },
        { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: "/_vitehub/**" },
      )
      nitro.handlers = handlers
      addConsoleDevframeHandler(nitro, consoleRuntimeRoot)
      const plugins = Array.isArray(nitro.plugins)
        ? nitro.plugins.filter(candidate => !generatedConsolePluginRegistration(candidate))
        : []
      plugins.push(generatedPlugin)
      const publicAssets = Array.isArray(nitro.publicAssets) ? nitro.publicAssets.filter((asset) => asset?.baseURL !== "/_vitehub/assets") : []
      publicAssets.push({
        baseURL: "/_vitehub/assets",
        dir: consolePublicRoot,
        fallthrough: false,
      })

      consoleConfig.nitro = { ...nitro, handlers: nitro.handlers, plugins, publicAssets }
    },
    async configResolved(config) {
      root = config.root
      projectRoot ||= resolveViteHubProjectRoot(config.root)
      generatedPlugin ||= resolve(config.root, generatedConsolePlugin)
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
      databaseDiscoveryRoot = "database" in viteConfig
        ? configuredProjectRoot(viteConfig.database)
        : databaseDiscoveryRoot
      if ("database" in viteConfig) {
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
      addConsoleDevframeHandler(nitro, consoleRuntimeRoot)
      generatedPlugin ||= resolveGeneratedConsolePlugin(config.root, fixture, options.invocationRootState)
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
