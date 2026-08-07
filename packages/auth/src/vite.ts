import { resolve } from "node:path"
import { Readable } from "node:stream"

import { createNoExternalMerger, isServerEnvironment, mergeGeneratedViteHubWatchIgnored, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

import { resolveAuthViteConfig } from "./config.ts"
import { getAuthForDefinition, handleAuthRequest, resetAuth } from "./server.ts"
import { isAuthRequestPath } from "./shared.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin, ResolvedConfig, UserConfig } from "vite"
import type {
  AuthDefinition,
  AuthModuleOptions,
  ResolvedAuthViteConfig,
} from "./types.ts"

export const AUTH_DEFINITION_ID = "#vitehub/auth/definition"
export const AUTH_SERVER_ID = "#vitehub/auth/server"
export const AUTH_VITE_PLUGIN_NAME = "@vite-hub/auth/vite"

const RESOLVED_AUTH_DEFINITION_ID = `\0${AUTH_DEFINITION_ID}`
const RESOLVED_AUTH_SERVER_ID = `\0${AUTH_SERVER_ID}`
const authPackageName = "@vite-hub/auth"
const envServerModuleId = "#vitehub/env/server"
const envVitePluginName = "@vite-hub/env/vite"
const generatedAuthAccessMiddlewareHandler = ".vitehub/auth/access-middleware.ts"
const generatedAuthRouteHandler = ".vitehub/auth/route.ts"
const mergeNoExternal = createNoExternalMerger(authPackageName)

type NitroConfig = Record<string, unknown>
type NitroHandler = { handler: string; method?: string; middleware?: boolean; route: string }

export interface AuthVitePluginAPI {
  getConfig: () => ResolvedAuthViteConfig | undefined
  refresh: () => ResolvedAuthViteConfig | undefined
}

export type AuthVitePlugin = Plugin & { api: AuthVitePluginAPI }

export function createAuthNitroConfig(plugin: AuthVitePlugin, options: {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  viteAuth?: AuthModuleOptions
}): Record<string, unknown> {
  const viteConfigResult = plugin.config && typeof plugin.config === "function"
    ? plugin.config.call({} as never, {
        root: options.projectRoot,
        nitro: options.nitro,
        auth: options.viteAuth,
        ...(options.serverDirs ? { [VITEHUB_SERVER_DIRS]: options.serverDirs } : {}),
      } as UserConfig & { nitro: Record<string, unknown> }, { command: "build", isPreview: false, isSsrBuild: true, mode: "production" })
    : undefined
  return (viteConfigResult && typeof viteConfigResult === "object" && "nitro" in viteConfigResult ? viteConfigResult.nitro : options.nitro) as Record<string, unknown>
}

type InternalAuthModuleOptions = AuthModuleOptions & {
  importBase?: string
}

interface RequestInitWithDuplex extends RequestInit {
  duplex?: "half"
}

function renderAuthDefinitionModule(config: ResolvedAuthViteConfig | undefined): string {
  if (!config) {
    return "export const definition = undefined\nexport default definition\n"
  }
  return [
    `import definition from ${JSON.stringify(config.definition.handler)}`,
    "export { definition }",
    "export default definition",
    "",
  ].join("\n")
}

function renderAuthServerModule(options: { importBase?: string, serverEnv: boolean } = { serverEnv: false }): string {
  const importBase = options.importBase ?? authPackageName
  const serverImport = `${importBase}/server`
  return [
    ...(options.serverEnv
      ? [
          `import { setAuthRuntimeEnvResolver } from ${JSON.stringify(serverImport)}`,
          `import { useServerEnv } from ${JSON.stringify(envServerModuleId)}`,
          "setAuthRuntimeEnvResolver(useServerEnv)",
          "",
        ]
      : []),
    `export * from ${JSON.stringify(serverImport)}`,
    `export { handleAuth as default } from ${JSON.stringify(serverImport)}`,
    "",
  ].join("\n")
}

function renderAuthRouteHandler(): string {
  return [
    `export { default } from ${JSON.stringify(AUTH_SERVER_ID)}`,
    "",
  ].join("\n")
}

function renderAuthAccessMiddlewareHandler(config: ResolvedAuthViteConfig | undefined): string {
  const routes = JSON.stringify(config?.access.routes ?? [])
  return [
    `import { requireAuth } from ${JSON.stringify(AUTH_SERVER_ID)}`,
    "",
    `const routes = ${routes}`,
    "",
    "function routeMatches(pattern, pathname) {",
    "  if (pattern.endsWith('/**')) {",
    "    const base = pattern.slice(0, -3)",
    "    return pathname === base || pathname.startsWith(`${base}/`)",
    "  }",
    "  return pathname === pattern",
    "}",
    "",
    "function matchesAccessRoute(event) {",
    "  const method = event.req.method",
    "  const pathname = event.url.pathname",
    "  return routes.some(route => (!route.method || route.method.toUpperCase() === method) && routeMatches(route.route, pathname))",
    "}",
    "",
    "export default function viteHubAuthAccessMiddleware(event) {",
    "  if (!matchesAccessRoute(event)) return",
    "  return requireAuth(event)",
    "}",
    "",
  ].join("\n")
}

function authAmbientTypesPath(root: string): string {
  return resolve(root, ".vitehub", "types", "auth.d.ts")
}

function renderAuthAmbientTypes(options: { importBase?: string, serverEnv: boolean } = { serverEnv: false }): string {
  const importBase = options.importBase ?? authPackageName
  const serverImport = `${importBase}/server`
  return [
    ...(options.serverEnv
      ? [
          `import type { ServerEnv } from ${JSON.stringify(envServerModuleId)}`,
          "",
          "declare global {",
          "  namespace ViteHub {",
          "    interface AuthRuntimeEnv extends ServerEnv {}",
          "  }",
          "}",
          "",
        ]
      : []),
    `declare module ${JSON.stringify(AUTH_SERVER_ID)} {`,
    `  export * from ${JSON.stringify(serverImport)}`,
    `  export { handleAuth as default } from ${JSON.stringify(serverImport)}`,
    "}",
    "",
  ].join("\n")
}

async function refreshAuthGeneratedFiles(root: string, config?: ResolvedAuthViteConfig, options: { importBase?: string, serverEnv?: boolean } = {}): Promise<void> {
  await Promise.all([
    writeFileIfChanged(resolve(root, generatedAuthAccessMiddlewareHandler), renderAuthAccessMiddlewareHandler(config)),
    writeFileIfChanged(authAmbientTypesPath(root), renderAuthAmbientTypes({ importBase: options.importBase, serverEnv: Boolean(options.serverEnv) })),
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

function mergeNitroAuthHandler(value: unknown, config: ResolvedAuthViteConfig | undefined): NitroConfig {
  const nitro = cloneNitroConfig(value)
  if (!config) return nitro

  const existingHandlers = Array.isArray(nitro.handlers) ? nitro.handlers : []
  const authHandlers: NitroHandler[] = [
    ...(config.route === false
      ? []
      : [{
          handler: resolve(config.rootDir, generatedAuthRouteHandler),
          route: authRoutePattern(config.route),
        }]),
    ...(config.access.routes.length > 0
      ? [{
          handler: resolve(config.rootDir, generatedAuthAccessMiddlewareHandler),
          middleware: true,
          route: "/**",
        }]
      : []),
  ]
  if (!authHandlers.length) return nitro

  return {
    ...nitro,
    handlers: [...existingHandlers, ...authHandlers],
  }
}

function readForwardedProtocol(request: IncomingMessage): string {
  const value = request.headers["x-forwarded-proto"]
  return Array.isArray(value) ? value[0] ?? "http" : value ?? "http"
}

function createWebRequest(request: IncomingMessage): Request {
  const host = request.headers.host ?? "localhost"
  const url = new URL(request.url ?? "/", `${readForwardedProtocol(request)}://${host}`)
  const headers = new Headers()

  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "undefined") continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
      continue
    }
    headers.set(key, value)
  }

  const init: RequestInitWithDuplex = {
    headers,
    method: request.method,
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream
    init.duplex = "half"
  }

  return new Request(url, init)
}

async function sendWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status
  target.statusMessage = response.statusText
  const setCookieHeaders = response.headers.getSetCookie()
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" && setCookieHeaders.length > 0) return
    target.appendHeader(key, value)
  })
  for (const value of setCookieHeaders) {
    target.appendHeader("set-cookie", value)
  }

  if (!response.body) {
    target.end()
    return
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      target.write(Buffer.from(chunk.value))
    }
  }
  finally {
    target.end()
    reader.releaseLock()
  }
}

function loadAuthDefinitionModule(module: unknown): AuthDefinition | undefined {
  const value = module as { default?: AuthDefinition; definition?: AuthDefinition }
  return value.default ?? value.definition
}

export function hubAuth(options?: AuthModuleOptions): AuthVitePlugin {
  const importBase = (options as InternalAuthModuleOptions | undefined)?.importBase ?? authPackageName
  let resolved: ResolvedConfig | undefined
  let runtimeConfig: ResolvedAuthViteConfig | undefined
  let serverDirs: string[] | undefined
  let serverEnv = false

  function resolvedOptions(): AuthModuleOptions | undefined {
    return resolved?.auth ?? options
  }

  function refreshRuntimeConfig(): ResolvedAuthViteConfig | undefined {
    if (!resolved) return
    runtimeConfig = resolveAuthViteConfig(resolvedOptions(), resolved.root, { serverDirs })
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
    config(config) {
      const configRoot = config.root || process.cwd()
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const authConfig = resolveAuthViteConfig((config as { auth?: AuthModuleOptions }).auth ?? options, configRoot, { serverDirs })
      const nitro = mergeNitroAuthHandler((config as { nitro?: unknown }).nitro, authConfig)
      const hasNitroHandlers = Boolean(authConfig && (authConfig.route !== false || authConfig.access.routes.length > 0))
      return {
        ssr: {
          noExternal: mergeNoExternal(config.ssr?.noExternal),
        },
        ...(hasNitroHandlers
          ? {
              nitro,
            }
          : {}),
        server: {
          watch: {
            ignored: mergeGeneratedViteHubWatchIgnored(config.server?.watch?.ignored),
          },
        },
      }
    },
    async configResolved(config) {
      resolved = config
      serverEnv = hasServerEnvIntegration(config)
      const runtimeConfig = refreshRuntimeConfig()
      await refreshAuthGeneratedFiles(config.root, runtimeConfig, { importBase, serverEnv })
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        try {
          const config = runtimeConfig ?? refreshRuntimeConfig()
          if (!config || config.route === false || !request.url) {
            next()
            return
          }

          const url = new URL(request.url, "http://vitehub.local")
          if (!isAuthRequestPath(url.pathname, config.basePath)) {
            next()
            return
          }

          const module = await server.ssrLoadModule(AUTH_DEFINITION_ID)
          const definition = loadAuthDefinitionModule(module)
          if (!definition) {
            next()
            return
          }

          const webRequest = createWebRequest(request)
          const hasRequestRuntime = typeof definition.options === "function"
            || typeof definition.options.runtime === "function"
          const authResponse = hasRequestRuntime
            ? await handleAuthRequest(definition, webRequest)
            : await getAuthForDefinition(definition).handler(webRequest)
          await sendWebResponse(authResponse, response)
        }
        catch (error) {
          next(error)
        }
      })
    },
    handleHotUpdate(context) {
      const changed = context.file.replace(/\\/g, "/")
      const authDefinition = runtimeConfig?.definition.handler.replace(/\\/g, "/")
      if (changed !== authDefinition && !/\/?server\.auth\.(?:c|m)?[jt]s$/i.test(changed) && !/\/server\/auth\.(?:c|m)?[jt]s$/i.test(changed)) {
        return
      }

      refreshRuntimeConfig()

      const definitionModule = context.server.moduleGraph.getModuleById(RESOLVED_AUTH_DEFINITION_ID)
      if (definitionModule) {
        context.server.moduleGraph.invalidateModule(definitionModule)
      }
      const serverModule = context.server.moduleGraph.getModuleById(RESOLVED_AUTH_SERVER_ID)
      if (serverModule) {
        context.server.moduleGraph.invalidateModule(serverModule)
      }
    },
    resolveId(id) {
      if (id === AUTH_DEFINITION_ID) return RESOLVED_AUTH_DEFINITION_ID
      if (id === AUTH_SERVER_ID) return RESOLVED_AUTH_SERVER_ID
    },
    load(id) {
      if (id === RESOLVED_AUTH_DEFINITION_ID) return renderAuthDefinitionModule(runtimeConfig)
      if (id === RESOLVED_AUTH_SERVER_ID) return renderAuthServerModule({ importBase, serverEnv })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    auth?: AuthModuleOptions
  }
}
