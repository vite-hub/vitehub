import { Readable } from "node:stream"

import { createNoExternalMerger, isServerEnvironment } from "@vite-hub/internal/build/vite"

import { resolveAuthViteConfig } from "./config.ts"
import { createAuth } from "./server.ts"
import { isAuthRequestPath } from "./shared.ts"

import type { IncomingMessage, ServerResponse } from "node:http"
import type { Plugin, ResolvedConfig } from "vite"
import type {
  AuthDefinition,
  AuthModuleOptions,
  ResolvedAuthViteConfig,
  ViteHubAuth,
} from "./types.ts"

export const AUTH_DEFINITION_ID = "#vitehub/auth/definition"
export const AUTH_VITE_PLUGIN_NAME = "@vite-hub/auth/vite"

const RESOLVED_AUTH_DEFINITION_ID = `\0${AUTH_DEFINITION_ID}`
const authPackageName = "@vite-hub/auth"
const mergeNoExternal = createNoExternalMerger(authPackageName)

export interface AuthVitePluginAPI {
  getConfig: () => ResolvedAuthViteConfig | undefined
  refresh: () => ResolvedAuthViteConfig | undefined
}

export type AuthVitePlugin = Plugin & { api: AuthVitePluginAPI }

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
  let resolved: ResolvedConfig | undefined
  let runtimeConfig: ResolvedAuthViteConfig | undefined
  let devAuth: { auth: ViteHubAuth; definition: AuthDefinition } | undefined

  function resolvedOptions(): AuthModuleOptions | undefined {
    return resolved?.auth ?? options
  }

  function refreshRuntimeConfig(): ResolvedAuthViteConfig | undefined {
    if (!resolved) return
    runtimeConfig = resolveAuthViteConfig(resolvedOptions(), resolved.root)
    devAuth = undefined
    return runtimeConfig
  }

  return {
    name: AUTH_VITE_PLUGIN_NAME,
    api: {
      getConfig: () => runtimeConfig,
      refresh: refreshRuntimeConfig,
    },
    configResolved(config) {
      resolved = config
      refreshRuntimeConfig()
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

          if (devAuth?.definition !== definition) {
            devAuth = { auth: createAuth(definition) as unknown as ViteHubAuth, definition }
          }

          const currentAuth = devAuth
          if (!currentAuth) {
            next()
            return
          }

          await sendWebResponse(await currentAuth.auth.handler(createWebRequest(request)), response)
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
    },
    resolveId(id) {
      if (id === AUTH_DEFINITION_ID) return RESOLVED_AUTH_DEFINITION_ID
    },
    load(id) {
      if (id === RESOLVED_AUTH_DEFINITION_ID) return renderAuthDefinitionModule(runtimeConfig)
    },
  }
}

declare module "vite" {
  interface UserConfig {
    auth?: AuthModuleOptions
  }
}
