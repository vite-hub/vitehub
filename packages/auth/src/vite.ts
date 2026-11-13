import { dirname, relative, resolve } from "node:path"

import { createNoExternalAddition, generatedViteHubWatchIgnoredAddition, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { summarizeDefinitions } from "@vite-hub/internal/inspect"
import { flattenPluginOptions } from "@vite-hub/internal/contributions"

import { assertNoCachedAccessRoutes } from "./access-route-cache.ts"
import { resolveAuthViteConfig } from "./config.ts"
import { authAbilitiesCandidates, discoverAuthDefinitions } from "./discovery.ts"
import { resetAuth } from "./runtime-state.ts"
import { authTableNames } from "./table-names.ts"

import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { ContributionContext } from "@vite-hub/internal/contributions"
import type { ViteHubDefinitionSummary, ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type {
  AuthOptions,
  ResolvedAuthViteConfig,
} from "./types.ts"

export { resolveAuthViteConfig }

export const AUTH_ABILITIES_ID = "#vitehub/auth/abilities"
export const AUTH_DEFINITION_ID = "#vitehub/auth/definition"
export const AUTH_SERVER_ID = "#vitehub/auth/server"
export const AUTH_VITE_PLUGIN_NAME = "@vite-hub/auth/vite"

const RESOLVED_AUTH_ABILITIES_ID = `\0${AUTH_ABILITIES_ID}`
const RESOLVED_AUTH_DEFINITION_ID = `\0${AUTH_DEFINITION_ID}`
const RESOLVED_AUTH_SERVER_ID = `\0${AUTH_SERVER_ID}`
const authPackageName = "@vite-hub/auth"
const envServerModuleId = "#vitehub/env/server"
const envVitePluginName = "@vite-hub/env/vite"
const generatedAuthAccessMiddlewareHandler = ".vitehub/auth/access-middleware.ts"
const generatedAuthRouteHandler = ".vitehub/auth/route.ts"
const cachedAccessRouteGuardName = "vite-hub/auth-cached-access-route-guard"
const mergeNoExternal = createNoExternalAddition(authPackageName)

type NitroConfig = Record<string, unknown>
type NitroHandler = { handler: string; lazy?: boolean; method?: string; middleware?: boolean; route: string }
type NitroBuild = {
  hooks: { hook: (name: "build:before" | "build:config" | "build:reload", callback: () => Promise<void>) => void }
  logger: { warn: (error: unknown) => void }
  options: { baseURL?: string, builder?: string | false, routeRules: Parameters<typeof assertNoCachedAccessRoutes>[1] }
}

export interface AuthVitePluginAPI {
  getConfig: () => ResolvedAuthViteConfig | undefined
  refresh: () => ResolvedAuthViteConfig | undefined
}

/** The roots that the Database integration passes to `vitehub.databases`. */
export interface AuthDatabaseContributionContext extends ContributionContext {
  /** The root that Database Definitions are discovered from. */
  rootDir: string
  plugins?: readonly unknown[]
}

/** The Better Auth tables that Auth adds to the Database that `authDatabase()` names. */
export interface AuthDatabaseContribution {
  name: "auth"
  database: string
  dialect: "postgresql" | "sqlite"
  definition: { module: string, export: "authPostgresSchema" | "authSqliteSchema" }
  /** The schema keys and SQL names of the tables, so the Database lists them without loading the schema module. */
  tables: Readonly<Record<string, string>>
  reason: string
}

export type AuthVitePlugin = Plugin & {
  api: AuthVitePluginAPI
  vitehub: ViteHubInspectionPluginMetadata & ViteHubCliPluginMetadata & {
    databases: (context: AuthDatabaseContributionContext) => Promise<AuthDatabaseContribution[]>
  }
}

/**
 * The dialect of the Database that gets the Auth tables, read from its Definition without running it. Without a
 * Database Definition, the Database integration adds the implicit `default` Database, which uses SQLite unless another
 * contribution needs Postgres.
 */
async function readTargetDialect(context: AuthDatabaseContributionContext, database: string): Promise<"postgresql" | "sqlite"> {
  const { discoverDatabaseDefinitions, readDatabaseDefinitionDialect } = await import("@vite-hub/database/config")
  const { collectDatabaseContributions } = await import("@vite-hub/database/vite")
  // Forward the filtered list too: sibling factories can recursively collect contributions.
  const plugins = (await flattenPluginOptions(context.plugins)).filter(plugin => Reflect.get(plugin, "name") !== AUTH_VITE_PLUGIN_NAME)
  const contributions = await collectDatabaseContributions(plugins, { ...context, plugins })
  const target = discoverDatabaseDefinitions(context.rootDir, { contributions, serverDirs: context.serverDirs?.slice() }).find(definition => definition.name === database)
  return target ? readDatabaseDefinitionDialect(target.handler) : "sqlite"
}

interface AuthInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

/** Lists the Auth Definition as a serializable inspection summary. */
function inspectAuthDefinitions(options: AuthInspectionOptions): ViteHubDefinitionSummary[] {
  return summarizeDefinitions(options.projectRoot, discoverAuthDefinitions(options.rootDir, { serverDirs: options.serverDirs }), "server-auth")
}

export function createAuthNitroConfig(plugin: AuthVitePlugin, options: {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
}): Record<string, unknown> {
  const viteConfig: UserConfig & { nitro: Record<string, unknown> } = {
    root: options.projectRoot,
    nitro: options.nitro,
    ...(options.serverDirs ? { [VITEHUB_SERVER_DIRS]: options.serverDirs } : {}),
  }
  // SAFETY: This hook mutates the supplied Nitro config because Vite concatenates returned arrays.
  if (plugin.config && typeof plugin.config === "function") {
    const dev = options.nitro.dev === true
    plugin.config.call({} as never, viteConfig, { command: dev ? "serve" : "build", isPreview: false, isSsrBuild: true, mode: dev ? "development" : "production" })
  }
  return viteConfig.nitro
}

interface InternalAuthModuleOptions {
  importBase?: string
}

function renderAuthDefinitionModule(config: ResolvedAuthViteConfig | undefined, options: { importBase?: string, serverEnv: boolean } = { serverEnv: false }): string {
  if (!config) {
    return "export const definition = undefined\nexport default definition\n"
  }
  return [
    `import definition from ${JSON.stringify(config.definition.handler)}`,
    // The Auth server module imports this module, so the Env resolver is set before the first Auth instance.
    ...(options.serverEnv
      ? [
          `import { setAuthRuntimeEnvResolver } from ${JSON.stringify(`${options.importBase ?? authPackageName}/runtime/server`)}`,
          `import { useServerEnv } from ${JSON.stringify(envServerModuleId)}`,
          "setAuthRuntimeEnvResolver(useServerEnv, definition)",
        ]
      : []),
    "export { definition }",
    "export default definition",
    "",
  ].join("\n")
}

/** The rules of `shared/abilities.ts` for the server and the app, or no rules. */
function renderAuthAbilitiesModule(config: ResolvedAuthViteConfig | undefined): string {
  return config?.abilities ? `export { default } from ${JSON.stringify(config.abilities)}\n` : "export default {}\n"
}

function renderAuthServerModule(options: { importBase?: string } = {}): string {
  const serverImport = `${options.importBase ?? authPackageName}/server`
  return [
    `export * from ${JSON.stringify(serverImport)}`,
    `export { default } from ${JSON.stringify(serverImport)}`,
    "",
  ].join("\n")
}

function renderAuthRouteHandler(): string {
  return [
    `export { default } from ${JSON.stringify(AUTH_SERVER_ID)}`,
    "",
  ].join("\n")
}

function renderAuthAccessMiddlewareHandler(config: ResolvedAuthViteConfig | undefined, importBase = authPackageName): string {
  const routes = JSON.stringify(config?.access.routes ?? [])
  return [
    `import { createLazyAuthAccessHandler } from ${JSON.stringify(`${importBase}/runtime/server`)}`,
    "",
    // Every request runs this middleware. It loads Better Auth only for a request that an access route matches.
    `export default createLazyAuthAccessHandler(${routes}, () => import(${JSON.stringify(AUTH_SERVER_ID)}))`,
    "",
  ].join("\n")
}

/** A relative `import()` type specifier that resolves under NodeNext and bundler resolution: `auth.ts` becomes `auth.js`. */
function typeImportSpecifier(from: string, file: string): string {
  const path = relative(from, file).replaceAll("\\", "/").replace(/\.([cm]?)ts$/, ".$1js")
  return path.startsWith(".") ? path : `./${path}`
}

function authAmbientTypesPath(root: string): string {
  return resolve(root, ".vitehub", "types", "auth.d.ts")
}

function authServerTypesPath(root: string): string {
  return resolve(root, ".vitehub", "types", "auth-server.d.ts")
}

function renderAuthAmbientTypes(options: { abilities?: string, definition?: string, serverEnv: boolean } = { serverEnv: false }): string {
  const entries = [
    ...options.definition ? [`definition: typeof import(${JSON.stringify(options.definition)}).default`] : [],
    ...options.abilities ? [`abilities: typeof import(${JSON.stringify(options.abilities)}).default`] : [],
  ]
  const registry = entries.length ? [`interface AuthRegistry { ${entries.join("; ")} }`] : []
  // The ServerEnv import makes this file a module, so its global names need `declare global`.
  if (options.serverEnv) {
    return [
      `import type { ServerEnv } from ${JSON.stringify(envServerModuleId)}`,
      "",
      "declare global {",
      "  namespace ViteHub {",
      "    interface AuthRuntimeEnv extends ServerEnv {}",
      ...registry.map(line => `    ${line}`),
      "  }",
      "}",
      "",
    ].join("\n")
  }
  return registry.length ? ["declare namespace ViteHub {", ...registry.map(line => `  ${line}`), "}", ""].join("\n") : "export {}\n"
}

/**
 * The declaration of the virtual module. It stays out of a file with imports, which would make it an augmentation of
 * a module that must already resolve. When only the bundler resolves `#vitehub/auth/server`, the tsconfig would not
 * find it and the types of everything that imports the Auth handlers would be `any`.
 */
function renderAuthServerTypes(importBase: string = authPackageName): string {
  const serverImport = `${importBase}/server`
  return [
    `declare module ${JSON.stringify(AUTH_SERVER_ID)} {`,
    `  export * from ${JSON.stringify(serverImport)}`,
    `  export { default } from ${JSON.stringify(serverImport)}`,
    "}",
    "",
  ].join("\n")
}

async function refreshAuthGeneratedFiles(root: string, config?: ResolvedAuthViteConfig, options: { importBase?: string, serverEnv?: boolean } = {}): Promise<void> {
  await Promise.all([
    writeFileIfChanged(resolve(root, generatedAuthAccessMiddlewareHandler), renderAuthAccessMiddlewareHandler(config, options.importBase)),
    writeFileIfChanged(authAmbientTypesPath(root), renderAuthAmbientTypes({
      abilities: config?.abilities && typeImportSpecifier(dirname(authAmbientTypesPath(root)), config.abilities),
      definition: config && typeImportSpecifier(dirname(authAmbientTypesPath(root)), config.definition.handler),
      serverEnv: Boolean(options.serverEnv),
    })),
    writeFileIfChanged(authServerTypesPath(root), renderAuthServerTypes(options.importBase)),
    writeFileIfChanged(resolve(root, generatedAuthRouteHandler), renderAuthRouteHandler()),
  ])
}

function hasServerEnvIntegration(config: ResolvedConfig | undefined): boolean {
  return Array.isArray(config?.plugins) && config.plugins.some(plugin => plugin.name === envVitePluginName)
}

function cloneNitroConfig(value: unknown): NitroConfig {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function authRoutePattern(route: string): string {
  return `${route}/**`
}

const authApplicationBaseURLName = "__VITEHUB_AUTH_APP_BASE_URL__"
// Auth server code reads it to turn Better Auth's limiter on outside a development server, also on hosts without `NODE_ENV`.
const authDevName = "__VITEHUB_AUTH_DEV__"

/** Return Nitro `baseURL` when the host serves the app below a path, such as Nuxt `app.baseURL`. */
function nitroApplicationBaseURL(value: unknown): string | undefined {
  const nitro = cloneNitroConfig(value)
  const baseURL = typeof nitro.baseURL === "string" ? nitro.baseURL : "/"
  return baseURL.split("/").some(Boolean) ? baseURL : undefined
}

function mergeNitroAuthHandler(value: unknown, config: ResolvedAuthViteConfig | undefined, dev: boolean): NitroConfig {
  const nitro = cloneNitroConfig(value)
  if (!config) return nitro
  nitro.replace = { ...cloneNitroConfig(nitro.replace), [authDevName]: JSON.stringify(dev) }

  // Nitro serves Auth routes below its baseURL, so Auth server code needs the same path for Better Auth routes and callbacks.
  const applicationBaseURL = nitroApplicationBaseURL(nitro)
  if (applicationBaseURL) {
    nitro.replace = { ...cloneNitroConfig(nitro.replace), [authApplicationBaseURLName]: JSON.stringify(applicationBaseURL) }
  }

  const kit = createNitroServerKit(nitro)
  const authHandlers: NitroHandler[] = [
    ...(config.route === false
      ? []
      : [{
          handler: resolve(resolveViteHubProjectRoot(config.rootDir), generatedAuthRouteHandler),
          // Better Auth loads with the first Auth request, not when the server starts.
          lazy: true,
          route: authRoutePattern(config.route),
        }]),
    ...(config.access.routes.length > 0
      ? [{
          handler: resolve(resolveViteHubProjectRoot(config.rootDir), generatedAuthAccessMiddlewareHandler),
          middleware: true,
          route: "/**",
        }]
      : []),
  ]
  if (!authHandlers.length) return nitro

  for (const handler of authHandlers) kit.addHandler(handler)
  // SAFETY: The kit preserves the Nitro config object shape while adding only Nitro handlers.
  const merged = kit.config as NitroConfig
  if (config.access.routes.length > 0) {
    const { routes } = config.access
    const modules = (Array.isArray(merged.modules) ? merged.modules : []).filter(module => Reflect.get(Object(module), "name") !== cachedAccessRouteGuardName)
    merged.modules = [...modules, {
      name: cachedAccessRouteGuardName,
      setup(nitro: NitroBuild) {
        const check = () => assertNoCachedAccessRoutes(routes, nitro.options.routeRules, nitro.options.baseURL)
        // A bundler calls `build:config` after every `build:before` hook, such as Nuxt's `nitro:build:before`, and before
        // it builds or prerenders. Without a builder, Nitro calls only `build:before`.
        nitro.hooks.hook(nitro.options.builder === false ? "build:before" : "build:config", check)
        // In development, `nitro.updateConfig()` replaces the route rules and calls only `build:reload`. The development
        // server keeps the new rules and logs the error as a warning.
        nitro.hooks.hook("build:reload", () => check().catch((error: unknown) => nitro.logger.warn(error)))
      },
    }]
  }
  return merged
}

export function hubAuth(options?: AuthOptions, internalOptions: InternalAuthModuleOptions = {}): AuthVitePlugin {
  const importBase = internalOptions.importBase ?? authPackageName
  let resolved: ResolvedConfig | undefined
  let runtimeConfig: ResolvedAuthViteConfig | undefined
  let serverDirs: string[] | undefined
  let serverEnv = false

  function refreshRuntimeConfig(): ResolvedAuthViteConfig | undefined {
    if (!resolved) return
    runtimeConfig = resolveAuthViteConfig(options, resolved.root, { serverDirs })
    runtimeConfig ??= resolveAuthViteConfig(options, resolveViteHubProjectRoot(resolved.root), { serverDirs })
    resetAuth()
    return runtimeConfig
  }

  return {
    name: AUTH_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getConfig: () => runtimeConfig,
      refresh: refreshRuntimeConfig,
    },
    vitehub: {
      cli: async () => options === false ? undefined : (await import("./cli.ts")).createAuthCliContributor(),
      async databases(context) {
        const authOptions = options
        if (authOptions === false) return []
        const root = context.projectRoot ?? context.root
        const discovery = { serverDirs: context.serverDirs?.slice() ?? serverDirs }
        const config = resolveAuthViteConfig(authOptions, root, discovery) ?? resolveAuthViteConfig(authOptions, resolveViteHubProjectRoot(root), discovery)
        if (!config?.tables) return []
        const { database } = config.tables
        const dialect = await readTargetDialect(context, database)
        return [{
          name: "auth",
          database,
          dialect,
          definition: { module: `${importBase}/schema`, export: dialect === "postgresql" ? "authPostgresSchema" : "authSqliteSchema" },
          tables: authTableNames,
          reason: "Stores the Better Auth users, sessions, accounts, and verifications, the admin() fields, and the Console MCP OAuth clients and tokens of authDatabase().",
        }]
      },
      inspect: () => {
        if (options === false) return
        return {
          definitions: [{
            kind: "auth",
            label: "Auth",
            list: () => {
              const rootDir = resolve(resolved?.root ?? process.cwd())
              return inspectAuthDefinitions({ projectRoot: resolveViteHubProjectRoot(rootDir), rootDir, serverDirs })
            },
          }],
        }
      },
    },
    config(config, env) {
      const configRoot = config.root || process.cwd()
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const authConfig = resolveAuthViteConfig(options, configRoot, { serverDirs })
        ?? resolveAuthViteConfig(options, resolveViteHubProjectRoot(configRoot), { serverDirs })
      // Integrations such as the Nuxt module call this hook without a Vite environment.
      const dev = env?.command === "serve"
      const nitro = mergeNitroAuthHandler((config as { nitro?: unknown }).nitro, authConfig, dev)
      const hasNitroHandlers = Boolean(authConfig && (authConfig.route !== false || authConfig.access.routes.length > 0))
      const applicationBaseURL = authConfig ? nitroApplicationBaseURL(nitro) : undefined
      if (hasNitroHandlers || applicationBaseURL) {
        // Replace Nitro in place because Vite concatenates arrays from returned config hooks.
        Object.assign(config, { nitro })
      }
      const contribution: UserConfig = {
        // The optimizer resolves package #imports without Vite's virtual-module hooks.
        optimizeDeps: {
          exclude: [authPackageName, "vite-hub/auth"],
          include: [`${authPackageName} > better-auth/vue`],
        },
        ssr: {
          noExternal: mergeNoExternal(config.ssr?.noExternal),
        },
        server: {
          watch: {
            ignored: generatedViteHubWatchIgnoredAddition(config.server?.watch?.ignored),
          },
        },
      }
      // The default Vue Auth client sends requests below the same Nitro baseURL.
      contribution.define = {
        [authDevName]: JSON.stringify(dev),
        ...(applicationBaseURL ? { [authApplicationBaseURLName]: JSON.stringify(applicationBaseURL) } : {}),
      }
      return contribution
    },
    async configResolved(config) {
      resolved = config
      serverEnv = hasServerEnvIntegration(config)
      const runtimeConfig = refreshRuntimeConfig()
      await refreshAuthGeneratedFiles(resolveViteHubProjectRoot(config.root), runtimeConfig, { importBase, serverEnv })
    },
    configureServer(server) {
      const root = server.config.root
      const projectRoot = resolveViteHubProjectRoot(root)
      const candidates = new Set([root, projectRoot].flatMap((directory) => {
        const files = authAbilitiesCandidates(directory, { serverDirs })
        return [...files.app, ...files.layers]
      }))
      // Watch directories so new files also emit add events, including layers outside the Vite root.
      server.watcher.add([...new Set([...candidates].map(dirname))])
      let refresh = Promise.resolve()
      const onAbilitiesFile = (file: string) => {
        if (!candidates.has(resolve(file))) return
        refresh = refresh.then(async () => {
          const config = refreshRuntimeConfig()
          await refreshAuthGeneratedFiles(projectRoot, config, { importBase, serverEnv })
          for (const environment of Object.values(server.environments)) {
            for (const id of [RESOLVED_AUTH_ABILITIES_ID, RESOLVED_AUTH_DEFINITION_ID, RESOLVED_AUTH_SERVER_ID]) {
              const module = environment.moduleGraph.getModuleById(id)
              if (module) environment.moduleGraph.invalidateModule(module)
            }
          }
          server.ws.send({ type: "full-reload" })
        }).catch(error => server.config.logger.error(String(error)))
      }
      server.watcher.on("add", onAbilitiesFile)
      server.watcher.on("unlink", onAbilitiesFile)
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async handleHotUpdate(context) {
      const changed = context.file.replace(/\\/g, "/")
      const authDefinition = runtimeConfig?.definition.handler.replace(/\\/g, "/")
      if (changed !== authDefinition && !/\/?server\.auth\.(?:c|m)?[jt]s$/i.test(changed) && !/\/server\/auth\.(?:c|m)?[jt]s$/i.test(changed)) {
        return
      }

      const config = refreshRuntimeConfig()
      await refreshAuthGeneratedFiles(resolveViteHubProjectRoot(context.server.config.root), config, { importBase, serverEnv })
      for (const id of [RESOLVED_AUTH_ABILITIES_ID, RESOLVED_AUTH_DEFINITION_ID, RESOLVED_AUTH_SERVER_ID]) {
        const module = context.server.moduleGraph.getModuleById(id)
        if (module) context.server.moduleGraph.invalidateModule(module)
      }
    },
    resolveId: {
      filter: { id: /^#vitehub\/auth\/(?:abilities|definition|server)$/ },
      handler(id) {
        if (id === AUTH_ABILITIES_ID) return RESOLVED_AUTH_ABILITIES_ID
        if (id === AUTH_DEFINITION_ID) return RESOLVED_AUTH_DEFINITION_ID
        if (id === AUTH_SERVER_ID) return RESOLVED_AUTH_SERVER_ID
      },
    },
    load: {
      filter: { id: /^\0#vitehub\/auth\/(?:abilities|definition|server)$/ },
      handler(id) {
        if (id === RESOLVED_AUTH_ABILITIES_ID) return renderAuthAbilitiesModule(runtimeConfig)
        if (id === RESOLVED_AUTH_DEFINITION_ID) return renderAuthDefinitionModule(runtimeConfig, { importBase, serverEnv })
        if (id === RESOLVED_AUTH_SERVER_ID) return renderAuthServerModule({ importBase })
      },
    },
  }
}

