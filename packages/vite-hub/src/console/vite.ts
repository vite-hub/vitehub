import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import type { AuthModuleOptions, ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { Plugin } from "vite"
import type { ConsoleSectionId } from "./runtime/sections.ts"

import { discoverConsoleBuildCatalog, generatedConsolePlugin, writeConsoleNitroPlugin } from "./build.ts"
import { serializeConsoleRefresh } from "./refresh.ts"
import { consoleDefinitionSectionIds } from "./runtime/definitions.ts"

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
type ConsoleNitroConfig = {
  handlers?: Array<{ handler: string, route: string }>
  plugins?: string[]
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean }>
  [key: string]: unknown
}

export type ConsoleOptions =
  | { access: "auth", exposure?: never }
  | { access?: never, exposure: "host-managed" }

interface ConsoleVitePluginOptions {
  blobStores?: readonly string[]
  console?: true | ConsoleOptions
  kvStores?: readonly string[]
  preset?: string
  resolveAuthConfig?: (root: string, serverDirs: string[] | undefined, auth: AuthModuleOptions | undefined) => ResolvedAuthViteConfig | undefined
  sections?: readonly ConsoleSectionId[]
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
    agentsEnabled: boolean
    development: boolean
    preset?: string
    auth?: ResolvedAuthViteConfig
  },
): void {
  if (options.development) return
  if (options.agentsEnabled && options.preset && options.preset !== "node") {
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

export function discoverConsoleAgentNames(
  root: string,
  serverDirs: string[] = [join(root, "server")],
): string[] {
  return discoverAgentDefinitionEntries(root, serverDirs).map(agent => agent.name)
}

function generatedRegistration(value: string, path: string): boolean {
  return value === path || value.replaceAll("\\", "/").endsWith(`/${path}`)
}

export function consoleVitePlugin(options: ConsoleVitePluginOptions = {}): Plugin {
  const sections = options.sections ?? []
  const blobStores = options.blobStores ?? []
  const kvStores = options.kvStores ?? []
  let generatedPlugin: string | undefined
  let projectRoot: string | undefined
  let root: string | undefined
  let serverDirs: string[] | undefined

  const refreshConsoleCatalog = serializeConsoleRefresh(async () => {
    if (!generatedPlugin || !projectRoot || !root) return
    await writeConsoleNitroPlugin(generatedPlugin, {
      blobStores,
      catalog: await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot, sections, serverDirs }),
      kvStores,
      projectRoot,
      sections,
    })
  })

  return {
    name: "vite-hub/console",
    async config(config, environment) {
      root = resolve(config.root || process.cwd())
      const configured = options.console ?? true
      // SAFETY: ViteHub Auth and server discovery extend Vite's user config with these documented keys.
      const viteConfig = config as typeof config & {
        [VITEHUB_SERVER_DIRS]?: string[]
        auth?: AuthModuleOptions
      }
      assertConsoleProductionAccess(configured, {
        agentsEnabled: sections.includes("agents"),
        auth: configured !== true && configured.access === "auth"
          ? options.resolveAuthConfig?.(root, viteConfig[VITEHUB_SERVER_DIRS], viteConfig.auth)
          : undefined,
        development: environment.command !== "build",
        preset: options.preset,
      })
      projectRoot = resolveViteHubProjectRoot(root)
      generatedPlugin = resolve(root, generatedConsolePlugin)
      await writeConsoleNitroPlugin(generatedPlugin, {
        blobStores,
        catalog: await discoverConsoleBuildCatalog({ discoveryRoot: root, projectRoot, sections }),
        kvStores,
        projectRoot,
        sections,
      })

      // SAFETY: Nitro extends Vite's user config with this documented top-level configuration object.
      const consoleConfig = viteConfig as typeof viteConfig & { nitro?: ConsoleNitroConfig }
      const nitro: ConsoleNitroConfig = consoleConfig.nitro
        ? { ...consoleConfig.nitro }
        : {}
      const handlers = Array.isArray(nitro.handlers)
        ? nitro.handlers.filter(handler => ![
                join(consoleRuntimeRoot, "server/blob.get.js"),
                join(consoleRuntimeRoot, "server/definitions.get.js"),
                join(consoleRuntimeRoot, "server/invocation.get.js"),
                join(consoleRuntimeRoot, "server/invocations.get.js"),
                join(consoleRuntimeRoot, "server/kv.get.js"),
                join(consoleRuntimeRoot, "server/agents.get.js"),
                join(consoleRuntimeRoot, "server/sections.get.js"),
                join(consoleRuntimeRoot, "server/search.get.js"),
                join(consoleRuntimeRoot, "server/page.get.js"),
              ].includes(handler?.handler),
          )
        : []
      handlers.push(
        {
          handler: join(consoleRuntimeRoot, "server/sections.get.js"),
          route: "/api/_vitehub/console/sections",
        },
        ...(consoleDefinitionSectionIds.some(section => sections.includes(section))
          ? [{
              handler: join(consoleRuntimeRoot, "server/definitions.get.js"),
              route: "/api/_vitehub/console/definitions",
            }]
          : []),
        ...(sections.includes("agents")
          ? [
              {
                handler: join(consoleRuntimeRoot, "server/agents.get.js"),
                route: "/api/_vitehub/console/agents",
              },
              {
                handler: join(consoleRuntimeRoot, "server/invocations.get.js"),
                route: "/api/_vitehub/console/invocations",
              },
              {
                handler: join(consoleRuntimeRoot, "server/invocation.get.js"),
                route: "/api/_vitehub/console/invocations/:id",
              },
              {
                handler: join(consoleRuntimeRoot, "server/search.get.js"),
                route: "/api/_vitehub/console/search",
              },
            ]
          : []),
        ...(sections.includes("blob")
          ? [{
              handler: join(consoleRuntimeRoot, "server/blob.get.js"),
              route: "/api/_vitehub/console/blob",
            }]
          : []),
        ...(sections.includes("kv")
          ? [{
              handler: join(consoleRuntimeRoot, "server/kv.get.js"),
              route: "/api/_vitehub/console/kv",
            }]
          : []),
        { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: "/_vitehub" },
        { handler: join(consoleRuntimeRoot, "server/page.get.js"), route: "/_vitehub/**" },
      )
      const plugins = Array.isArray(nitro.plugins) ? nitro.plugins.filter((candidate) => !generatedRegistration(candidate, generatedConsolePlugin)) : []
      plugins.push(generatedPlugin)
      const publicAssets = Array.isArray(nitro.publicAssets) ? nitro.publicAssets.filter((asset) => asset?.baseURL !== "/_vitehub/assets") : []
      publicAssets.push({
        baseURL: "/_vitehub/assets",
        dir: consolePublicRoot,
        fallthrough: false,
      })

      consoleConfig.nitro = { ...nitro, handlers, plugins, publicAssets }
    },
    async configResolved(config) {
      root = config.root
      projectRoot ||= resolveViteHubProjectRoot(config.root)
      generatedPlugin ||= resolve(config.root, generatedConsolePlugin)
      // SAFETY: VITEHUB_SERVER_DIRS is ViteHub-owned config state populated with string paths.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      await refreshConsoleCatalog()
    },
    configureServer(server) {
      const refresh = async () => await refreshConsoleCatalog()
      server.watcher.on("add", refresh)
      server.watcher.on("change", refresh)
      server.watcher.on("unlink", refresh)
    },
  }
}

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/").split("?", 1)[0]!
}

export function consoleInvocationRootPlugin(configuredProjectRoot?: string): Plugin {
  const frameworkAgentEntries = new Set<string>()
  let projectRoot = configuredProjectRoot

  function rememberFrameworkAgent(id: string): void {
    frameworkAgentEntries.add(normalizeModuleId(id))
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
    },
    async buildStart() {
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
      return `globalThis[Symbol.for("vitehub.console.project.root")] = ${JSON.stringify(projectRoot)}\n${code}`
    },
  }
}
