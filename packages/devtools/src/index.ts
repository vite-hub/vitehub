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

export const viteHubDevtoolsPanelId = "@vite-hub/devtools"
export const viteHubDevtoolsTitle = "ViteHub"
export const viteHubDevtoolsDefaultUrl = "/__vitehub/devtools/"
export const viteHubDevtoolsHostedUrl = "https://devtools.vitehub.dev/"
const viteHubDevtoolsUrlEnv = "VITEHUB_DEVTOOLS_URL"
export const viteHubDevtoolsGetFeaturesRpc = "@vite-hub/devtools:get-features"

const devtoolsShellPublicDirectory = fileURLToPath(new URL("../devtools/chat/.output/public", import.meta.url))
const devtoolsShellRoute = viteHubDevtoolsDefaultUrl
const devtoolsShellRouteWithoutSlash = devtoolsShellRoute.replace(/\/$/, "")
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

const registryKey = Symbol.for("@vite-hub/devtools:registry")

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

function rewriteDevtoolsShellIndex(html: string): string {
  return html
    .replaceAll('href="/_nuxt/', `href="${devtoolsShellRoute}_nuxt/`)
    .replaceAll('src="/_nuxt/', `src="${devtoolsShellRoute}_nuxt/`)
    .replaceAll('href:"/_nuxt/', `href:"${devtoolsShellRoute}_nuxt/`)
    .replaceAll('src:"/_nuxt/', `src:"${devtoolsShellRoute}_nuxt/`)
    .replace('baseURL:"/"', `baseURL:"${devtoolsShellRoute}"`)
    .replace('buildAssetsDir:"/_nuxt/"', `buildAssetsDir:"${devtoolsShellRoute}_nuxt/"`)
}

function resolveDevtoolsShellFile(pathname: string): string | undefined {
  if (pathname === devtoolsShellRouteWithoutSlash || pathname === devtoolsShellRoute) {
    return join(devtoolsShellPublicDirectory, "index.html")
  }

  if (!pathname.startsWith(devtoolsShellRoute)) {
    return undefined
  }

  const requestedPath = decodeURIComponent(pathname.slice(devtoolsShellRoute.length))
  const filePath = resolve(devtoolsShellPublicDirectory, requestedPath || "index.html")
  const relativePath = relative(devtoolsShellPublicDirectory, filePath)
  if (relativePath.startsWith("..") || relativePath === "" || resolve(relativePath) === relativePath) {
    return undefined
  }

  return filePath
}

function registerDevtoolsShellMiddleware(server: ViteDevServer): void {
  server.middlewares.use(async (request, response, next) => {
    if (!request.url) {
      next()
      return
    }

    const pathname = new URL(request.url, "http://vitehub.local").pathname
    const filePath = resolveDevtoolsShellFile(pathname)
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
        response.end(rewriteDevtoolsShellIndex(await readFile(filePath, "utf8")))
        return
      }

      createReadStream(filePath).pipe(response)
    }
    catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        response.statusCode = 404
        response.end("ViteHub DevTools shell has not been built. Run `pnpm --filter @vite-hub/devtools build:chat`.")
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
      message: `${feature.title} DevTools feature is enabled, but the ViteHub DevTools Integration is not installed. Add hubDevtools() from @vite-hub/devtools to your Vite plugins.`,
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
    name: "@vite-hub/devtools/vite",
    configureServer(server) {
      if (options.enabled === false) {
        return
      }

      registerDevtoolsShellMiddleware(server)
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
