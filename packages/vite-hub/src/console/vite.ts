import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { AuthModuleOptions, ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { ViteHubCliContributingPlugin } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"

import { serializeConsoleRefresh } from "./refresh.ts"
import { createConsoleCliNamespace } from "./cli.ts"
import { consoleFixtureEnvironmentVariable, consoleFixtureRevision, readConsoleFixture } from "./fixture.ts"
import { bindConsoleInvocationsIdentity, createConsoleInvocationsIdentity, releaseConsoleInvocationsBinding } from "./internal.ts"
import { installConsoleFixtureInvocations } from "./runtime/server/invocations.ts"

const frameworkAgentSpecifier = "vite-hub/agent"
function resolveConsoleRuntimeRoot(): string {
  const root = [
    fileURLToPath(new URL("./runtime", import.meta.url)),
    fileURLToPath(new URL("./console/runtime", import.meta.url)),
  ].find(root => ["page.get.ts", "page.get.js"].some(file => existsSync(join(root, "server", file))))
  if (!root) throw new Error("[vitehub] Could not locate the packaged Console runtime.")
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
  handlers?: Array<{ handler: string, route: string }>
  plugins?: string[]
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean }>
  [key: string]: unknown
}

type ConsoleAgentEntry = { handler: string, name: string }

export type ConsoleOptions =
  | { access: "auth", exposure?: never }
  | { access?: never, exposure: "host-managed" }

interface ConsoleVitePluginOptions {
  console?: true | ConsoleOptions
  preset?: string
  resolveAuthConfig?: (root: string, serverDirs: string[] | undefined, auth: AuthModuleOptions | undefined) => ResolvedAuthViteConfig | undefined
  invocationRootState?: ConsoleInvocationRootState
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

const consoleAccessRoutes = ["/_vitehub/**", "/api/_vitehub/console/**"] as const

function authRouteProtects(route: ResolvedAuthViteConfig["access"]["routes"][number], target: string): boolean {
  if (!route.authorize || (route.method && route.method.toUpperCase() !== "GET")) return false
  if (!route.route.endsWith("/**")) return false
  const routeBase = route.route.slice(0, -3)
  const targetBase = target.slice(0, -3)
  return targetBase === routeBase || targetBase.startsWith(`${routeBase}/`)
}

export function assertConsoleProductionAccess(
  configured: true | ConsoleOptions,
  options: {
    development: boolean
    preset?: string
    auth?: ResolvedAuthViteConfig
  },
): void {
  if (options.development) return
  if (options.preset && options.preset !== "node") {
    throw new Error(
      `[vitehub] Console currently requires preset: "node" for production because its fallback journal uses durable local SQLite. Disable Console for the ${JSON.stringify(options.preset)} production build or deploy it with the Node preset.`,
    )
  }
  if (configured === true) {
    throw new Error('[vitehub] console: true is development-only. Production Console builds require console: { access: "auth" } or console: { exposure: "host-managed" }.')
  }
  if (configured.exposure === "host-managed") return
  if (configured.access !== "auth") {
    throw new TypeError('[vitehub] Console production access must use access: "auth" or exposure: "host-managed".')
  }
  if (!options.auth) {
    throw new Error('[vitehub] console: { access: "auth" } requires a discovered ViteHub Auth Definition.')
  }
  const missing = consoleAccessRoutes.filter(target => !options.auth?.access.routes.some(route => authRouteProtects(route, target)))
  if (missing.length) {
    throw new Error(`[vitehub] Console Auth access must configure an authorize callback for ${missing.join(" and ")}.`)
  }
}

function renderConsoleNitroPlugin(
  projectRoot: string,
  agents: readonly ConsoleAgentEntry[],
  fixture?: string,
  fixtureSnapshot = fixture ? readConsoleFixture(fixture) : undefined,
  runtimeBinding?: string,
): string {
  const revision = fixtureSnapshot ? consoleFixtureRevision(fixtureSnapshot) : undefined
  const fixtureSource = fixtureSnapshot ? `JSON.parse(${JSON.stringify(JSON.stringify(fixtureSnapshot))})` : undefined
  return [
    `import { installConsoleAgentDefinitions, installConsoleFixtureInvocations, installConsoleInvocations } from "vite-hub/console/server"`,
    ...agents.map((agent, index) => `import * as vitehubConsoleAgent${index} from ${JSON.stringify(pathToFileURL(agent.handler).href)}`),
    fixture
      ? `const vitehubConsoleInvocations = installConsoleFixtureInvocations(${JSON.stringify(projectRoot)}, ${JSON.stringify(fixture)}, ${fixtureSource}, ${JSON.stringify(revision)}, ${JSON.stringify(runtimeBinding)})`
      : `const vitehubConsoleInvocations = installConsoleInvocations(${JSON.stringify(projectRoot)})`,
    `installConsoleAgentDefinitions([${agents.map((agent, index) => `{ definition: vitehubConsoleAgent${index}, fallbackName: ${JSON.stringify(agent.name)} }`).join(", ")}], vitehubConsoleInvocations)`,
    "export default function viteHubConsolePlugin() {}",
    "",
  ].join("\n")
}

async function writeConsoleNitroPlugin(
  file: string,
  projectRoot: string,
  agents: readonly ConsoleAgentEntry[],
  fixture?: string,
  runtimeBinding?: string,
  active: () => boolean = () => true,
): Promise<string> {
  const snapshot = fixture ? readConsoleFixture(fixture) : undefined
  const contents = renderConsoleNitroPlugin(projectRoot, agents, fixture, snapshot, runtimeBinding)
  if (await readFile(file, "utf8").catch(() => undefined) !== contents) {
    await mkdir(resolve(file, ".."), { recursive: true })
    await writeFile(file, contents, "utf8")
  }
  if (fixture && snapshot && active()) {
    installConsoleFixtureInvocations(projectRoot, fixture, snapshot, consoleFixtureRevision(snapshot), runtimeBinding)
  }
  return createConsoleInvocationsIdentity(
    projectRoot,
    fixture,
    snapshot ? consoleFixtureRevision(snapshot) : undefined,
    runtimeBinding,
  )
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
  let generatedPlugin: string | undefined
  let projectRoot: string | undefined
  let root: string | undefined
  let serverDirs: string[] | undefined
  let fixture: string | undefined
  let cliDiscovery = false

  const refreshAgentDefinitions = serializeConsoleRefresh(async () => {
    if (!generatedPlugin || !projectRoot || !root) return
    const identity = await writeConsoleNitroPlugin(
      generatedPlugin,
      projectRoot,
      discoverAgentDefinitionEntries(root, serverDirs),
      fixture,
      options.invocationRootState?.binding,
      () => !options.invocationRootState?.closed,
    )
    if (options.invocationRootState) {
      updateConsoleInvocationRootState(options.invocationRootState, projectRoot, identity)
    }
  })

  const plugin: Plugin & ViteHubCliContributingPlugin = {
    name: "vite-hub/console",
    async config(config, environment) {
      root = resolve(config.root || process.cwd())
      const configured = options.console ?? true
      // SAFETY: ViteHub Auth and server discovery extend Vite's user config with these documented keys.
      const viteConfig = config as typeof config & {
        [VITEHUB_SERVER_DIRS]?: string[]
        auth?: AuthModuleOptions
        vitehubCliDiscovery?: true
      }
      cliDiscovery = viteConfig.vitehubCliDiscovery === true
      assertConsoleProductionAccess(configured, {
        auth: configured !== true && configured.access === "auth"
          ? options.resolveAuthConfig?.(root, viteConfig[VITEHUB_SERVER_DIRS], viteConfig.auth)
          : undefined,
        development: environment.command !== "build",
        preset: options.preset,
      })
      projectRoot = resolveViteHubProjectRoot(root)
      const configuredFixture = viteConfig.vitehubCliDiscovery
        ? undefined
        : process.env[consoleFixtureEnvironmentVariable]
      fixture = undefined
      if (configuredFixture) {
        if (environment.command === "build") {
          throw new Error("[vitehub] Console fixture mode is development-only.")
        }
        fixture = resolve(projectRoot, configuredFixture)
        readConsoleFixture(fixture)
      }
      generatedPlugin = resolveGeneratedConsolePlugin(root, fixture, options.invocationRootState)
      if (fixture && options.invocationRootState) {
        configureConsoleFixtureLifecycle(options.invocationRootState, generatedPlugin, refreshAgentDefinitions)
      }
      if (!cliDiscovery && !fixture) {
        await writeConsoleNitroPlugin(
          generatedPlugin,
          projectRoot,
          discoverAgentDefinitionEntries(root),
          fixture,
          options.invocationRootState?.binding,
        )
      }

      // SAFETY: Nitro extends Vite's user config with this documented top-level configuration object.
      const consoleConfig = viteConfig as typeof viteConfig & { nitro?: ConsoleNitroConfig }
      const nitro: ConsoleNitroConfig = consoleConfig.nitro
        ? { ...consoleConfig.nitro }
        : {}
      const handlers = Array.isArray(nitro.handlers)
        ? nitro.handlers.filter(handler => ![
            join(consoleRuntimeRoot, "server/invocation.get.js"),
            join(consoleRuntimeRoot, "server/invocations.get.js"),
            join(consoleRuntimeRoot, "server/agents.get.js"),
            join(consoleRuntimeRoot, "server/search.get.js"),
            join(consoleRuntimeRoot, "server/page.get.js"),
          ].includes(handler?.handler))
        : []
      handlers.push(
        { handler: join(consoleRuntimeRoot, "server/agents.get.js"), route: "/api/_vitehub/console/agents" },
        { handler: join(consoleRuntimeRoot, "server/invocations.get.js"), route: "/api/_vitehub/console/invocations" },
        { handler: join(consoleRuntimeRoot, "server/invocation.get.js"), route: "/api/_vitehub/console/invocations/:id" },
        { handler: join(consoleRuntimeRoot, "server/search.get.js"), route: "/api/_vitehub/console/search" },
        { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: "/_vitehub" },
        { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: "/_vitehub/**" },
      )
      const plugins = Array.isArray(nitro.plugins)
        ? nitro.plugins.filter(candidate => !generatedConsolePluginRegistration(candidate))
        : []
      plugins.push(generatedPlugin)
      const publicAssets = Array.isArray(nitro.publicAssets)
        ? nitro.publicAssets.filter(asset => asset?.baseURL !== "/_vitehub/assets")
        : []
      publicAssets.push({ baseURL: "/_vitehub/assets", dir: consolePublicRoot, fallthrough: false })

      consoleConfig.nitro = { ...nitro, handlers, plugins, publicAssets }
    },
    async configResolved(config) {
      root = config.root
      projectRoot ||= resolveViteHubProjectRoot(config.root)
      generatedPlugin ||= resolveGeneratedConsolePlugin(config.root, fixture, options.invocationRootState)
      // SAFETY: VITEHUB_SERVER_DIRS is ViteHub-owned config state populated with string paths.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      if (!cliDiscovery && !fixture) await refreshAgentDefinitions()
    },
    buildStart: {
      order: "post",
      async handler() {
        if (!cliDiscovery && fixture) await refreshAgentDefinitions()
      },
    },
    configureServer(server) {
      if (fixture) server.watcher.add(fixture)
      const refresh = async () => {
        try {
          await refreshAgentDefinitions()
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
  const activeEnvironments = new Set<object>()
  let projectRoot = configuredProjectRoot
  let identity = configuredIdentity
  let fixtureConfigured = false

  function rememberFrameworkAgent(id: string): void {
    frameworkAgentEntries.add(normalizeModuleId(id))
  }

  async function closeEnvironment(environment: object | undefined): Promise<void> {
    if (environment) activeEnvironments.delete(environment)
    if (activeEnvironments.size > 0) return
    state.closed = true
    if (state.binding) releaseConsoleInvocationsBinding(state.binding)
    await state.fixtureLifecycle?.close()
  }

  return {
    name: "vite-hub/console-invocation-root",
    applyToEnvironment: environment => environment.config.consumer === "server",
    perEnvironmentStartEndDuringDev: true,
    configEnvironment(_name, config) {
      if (config.consumer !== "server") return
      return { resolve: { noExternal: ["vite-hub"] } }
    },
    configResolved(config) {
      projectRoot ||= resolveViteHubProjectRoot(config.root)
      // SAFETY: ViteHub extends Vite's resolved config with its CLI discovery marker.
      const configuredFixture = (config as typeof config & { vitehubCliDiscovery?: true }).vitehubCliDiscovery
        ? undefined
        : process.env[consoleFixtureEnvironmentVariable]
      const fixture = configuredFixture ? resolve(projectRoot, configuredFixture) : undefined
      fixtureConfigured = Boolean(fixture)
      const revision = fixture ? consoleFixtureRevision(readConsoleFixture(fixture)) : undefined
      identity ||= createConsoleInvocationsIdentity(
        projectRoot,
        fixture,
        revision,
        state.binding,
      )
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
