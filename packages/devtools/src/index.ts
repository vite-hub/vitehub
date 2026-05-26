import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { extname, join, relative, resolve } from "node:path"
import { defineDockEntry, defineRpcFunction } from "@vitejs/devtools-kit"

import type { DevToolsDockEntry, DevToolsViewIframe, ViteDevToolsNodeContext } from "@vitejs/devtools-kit"
import type { Plugin, ViteDevServer } from "vite"

export interface ViteHubDevtoolsFeature {
  bridge: string
  icon?: DevToolsDockEntry["icon"]
  id: string
  packageName: string
  title: string
}

export interface HubDevtoolsOptions {
  enabled?: boolean
  icon?: DevToolsDockEntry["icon"]
  title?: string
  url?: string
}

export const viteHubDevtoolsPanelId = "@vitehub/devtools"
export const viteHubDevtoolsTitle = "ViteHub"
export const viteHubDevtoolsDefaultUrl = "/__vitehub/devtools/chat/"
export const viteHubDevtoolsHostedUrl = "https://devtools.vitehub.dev/chat/"
const viteHubDevtoolsUrlEnv = "VITEHUB_DEVTOOLS_URL"
export const viteHubDevtoolsGetFeaturesRpc = "@vitehub/devtools:get-features"

const chatShellPublicDirectory = fileURLToPath(new URL("../devtools/chat/.output/public", import.meta.url))
const chatShellRoute = viteHubDevtoolsDefaultUrl
const chatShellRouteWithoutSlash = chatShellRoute.replace(/\/$/, "")
const textFileTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
}

const binaryFileTypes: Record<string, string> = {
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

interface ViteHubDevtoolsRegistry {
  missingShellWarnings: Set<string>
  registeredFeatures: Map<string, ViteHubDevtoolsFeature>
  registeredShellPanel: boolean
  registeredShellRpc: boolean
  registeredShell: boolean
}

const registryKey = Symbol.for("@vitehub/devtools:registry")

function getRegistry(ctx: ViteDevToolsNodeContext): ViteHubDevtoolsRegistry {
  return (ctx as ViteDevToolsNodeContext & { [registryKey]?: ViteHubDevtoolsRegistry })[registryKey] ??= {
    missingShellWarnings: new Set(),
    registeredFeatures: new Map(),
    registeredShell: false,
    registeredShellPanel: false,
    registeredShellRpc: false,
  }
}

function isRemoteDevtoolsUrl(url: string): boolean {
  return /^https?:\/\//.test(url)
}

function resolveDevtoolsUrl(options: Pick<HubDevtoolsOptions, "url">): string {
  return options.url || process.env[viteHubDevtoolsUrlEnv] || viteHubDevtoolsDefaultUrl
}

function getContentType(filePath: string): string {
  const extension = extname(filePath)
  return textFileTypes[extension] || binaryFileTypes[extension] || "application/octet-stream"
}

function rewriteChatShellIndex(html: string): string {
  return html
    .replaceAll('href="/_nuxt/', `href="${chatShellRoute}_nuxt/`)
    .replaceAll('src="/_nuxt/', `src="${chatShellRoute}_nuxt/`)
    .replaceAll('href:"/_nuxt/', `href:"${chatShellRoute}_nuxt/`)
    .replaceAll('src:"/_nuxt/', `src:"${chatShellRoute}_nuxt/`)
    .replace('baseURL:"/"', `baseURL:"${chatShellRoute}"`)
    .replace('buildAssetsDir:"/_nuxt/"', `buildAssetsDir:"${chatShellRoute}_nuxt/"`)
}

function resolveChatShellFile(pathname: string): string | undefined {
  if (pathname === chatShellRouteWithoutSlash || pathname === chatShellRoute) {
    return join(chatShellPublicDirectory, "index.html")
  }

  if (!pathname.startsWith(chatShellRoute)) {
    return undefined
  }

  const requestedPath = decodeURIComponent(pathname.slice(chatShellRoute.length))
  const filePath = resolve(chatShellPublicDirectory, requestedPath || "index.html")
  const relativePath = relative(chatShellPublicDirectory, filePath)
  if (relativePath.startsWith("..") || relativePath === "" || resolve(relativePath) === relativePath) {
    return undefined
  }

  return filePath
}

function registerChatShellMiddleware(server: ViteDevServer): void {
  server.middlewares.use(async (request, response, next) => {
    if (!request.url) {
      next()
      return
    }

    const pathname = new URL(request.url, "http://vitehub.local").pathname
    const filePath = resolveChatShellFile(pathname)
    if (!filePath) {
      next()
      return
    }

    try {
      const fileStat = await stat(filePath)
      if (!fileStat.isFile()) {
        response.statusCode = 404
        response.end("ViteHub DevTools asset not found")
        return
      }

      response.setHeader("content-type", getContentType(filePath))
      response.setHeader("cache-control", "no-cache")
      if (filePath.endsWith("index.html")) {
        response.end(rewriteChatShellIndex(await readFile(filePath, "utf8")))
        return
      }

      createReadStream(filePath).pipe(response)
    }
    catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        response.statusCode = 404
        response.end("ViteHub DevTools chat shell has not been built. Run `pnpm --filter @vitehub/devtools build:chat`.")
        return
      }

      next(error)
    }
  })
}

function registerViteHubDevtoolsShell(
  ctx: ViteDevToolsNodeContext,
  options: Required<Pick<HubDevtoolsOptions, "icon" | "title">> & Pick<HubDevtoolsOptions, "url">,
): void {
  const registry = getRegistry(ctx)
  if (registry.registeredShellPanel) {
    return
  }

  const url = resolveDevtoolsUrl(options)
  const entry: DevToolsViewIframe = {
    id: viteHubDevtoolsPanelId,
    title: options.title,
    icon: options.icon,
    type: "iframe",
    url,
    remote: isRemoteDevtoolsUrl(url),
  }
  ctx.docks.register(defineDockEntry(entry as never) as never)
  registry.registeredShellPanel = true
}

function warnIfDevtoolsShellMissing(ctx: ViteDevToolsNodeContext, feature: ViteHubDevtoolsFeature): void {
  queueMicrotask(() => {
    const registry = getRegistry(ctx)
    if (registry.registeredShell) {
      return
    }

    if (registry.missingShellWarnings.has(feature.id)) {
      return
    }

    registry.missingShellWarnings.add(feature.id)
    ctx.messages.add({
      level: "warn",
      message: `${feature.title} DevTools feature is enabled, but the ViteHub DevTools Integration is not installed. Add hubDevtools() from @vitehub/devtools to your Vite plugins.`,
    })
  })
}

function registerViteHubDevtoolsDiscoveryRpc(ctx: ViteDevToolsNodeContext): void {
  const registry = getRegistry(ctx)
  if (registry.registeredShellRpc) {
    return
  }

  ctx.rpc.register(defineRpcFunction({
    name: viteHubDevtoolsGetFeaturesRpc,
    type: "query",
    setup: () => ({ handler: () => listViteHubDevtoolsFeatures(ctx) }),
  }) as never)
  registry.registeredShellRpc = true
}

export function registerViteHubDevtoolsFeature(
  ctx: ViteDevToolsNodeContext,
  feature: ViteHubDevtoolsFeature,
): ViteHubDevtoolsFeature {
  const registry = getRegistry(ctx)
  const registered = registry.registeredFeatures.get(feature.id)
  if (registered) {
    return registered
  }

  registry.registeredFeatures.set(feature.id, feature)
  warnIfDevtoolsShellMissing(ctx, feature)
  return feature
}

export function listViteHubDevtoolsFeatures(ctx: ViteDevToolsNodeContext): ViteHubDevtoolsFeature[] {
  return [...getRegistry(ctx).registeredFeatures.values()]
}

export function hubDevtools(options: HubDevtoolsOptions = {}): Plugin {
  return {
    name: "@vitehub/devtools/vite",
    configureServer(server) {
      if (options.enabled === false) {
        return
      }

      registerChatShellMiddleware(server)
    },
    devtools: {
      setup(ctx) {
        if (options.enabled === false) {
          return
        }

        getRegistry(ctx).registeredShell = true
        registerViteHubDevtoolsShell(ctx, {
          icon: options.icon || "ph:toolbox-duotone",
          title: options.title || viteHubDevtoolsTitle,
          url: options.url,
        })

        registerViteHubDevtoolsDiscoveryRpc(ctx)
      },
    },
  }
}

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcServerFunctions {
    [viteHubDevtoolsGetFeaturesRpc]: () => ViteHubDevtoolsFeature[]
  }
}
