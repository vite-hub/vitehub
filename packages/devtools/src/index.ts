import { existsSync } from "node:fs"

import { defineDockEntry, defineRpcFunction } from "@vitejs/devtools-kit"

import type { DevToolsDockEntry, DevToolsViewIframe, ViteDevToolsNodeContext } from "@vitejs/devtools-kit"
import type { Plugin } from "vite"

export interface ViteHubDevtoolsPanelOptions {
  distDir?: string
  enabled?: boolean
  icon: DevToolsDockEntry["icon"]
  id: string
  route: string
  title: string
  url?: string
}

export interface RegisteredViteHubDevtoolsPanel {
  remote: boolean
  url: string
}

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
}

export const viteHubDevtoolsPanelId = "@vitehub/devtools"
export const viteHubDevtoolsTitle = "ViteHub"
export const viteHubDevtoolsDefaultUrl = "https://devtools.vitehub.dev/"
export const viteHubDevtoolsGetFeaturesRpc = "@vitehub/devtools:get-features"

const registeredPanels = new WeakMap<ViteDevToolsNodeContext, Map<string, RegisteredViteHubDevtoolsPanel>>()
const registeredFeatures = new WeakMap<ViteDevToolsNodeContext, Map<string, ViteHubDevtoolsFeature>>()
const registeredShells = new WeakSet<ViteDevToolsNodeContext>()
const missingShellWarnings = new WeakMap<ViteDevToolsNodeContext, Set<string>>()

export function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export function resolveViteHubDevtoolsUrl(defaultRoute: string, override?: string): string {
  return override?.trim() || defaultRoute
}

export function registerViteHubDevtoolsPanel(
  ctx: ViteDevToolsNodeContext,
  options: ViteHubDevtoolsPanelOptions,
): RegisteredViteHubDevtoolsPanel | undefined {
  if (options.enabled === false) {
    return
  }

  const url = resolveViteHubDevtoolsUrl(options.route, options.url)
  const remote = isAbsoluteHttpUrl(url)
  const registryKey = `${options.id}:${url}`
  const ctxPanels = registeredPanels.get(ctx)
  const registered = ctxPanels?.get(registryKey)
  if (registered) {
    return registered
  }

  if (!remote) {
    if (!options.distDir) {
      ctx.messages.add({
        level: "warn",
        message: `${options.title} DevTools client requires a local distDir for non-HTTP URLs.`,
      })
      return
    }

    if (!existsSync(options.distDir)) {
      ctx.messages.add({
        level: "warn",
        message: `${options.title} DevTools client is not built. Build its client assets before opening this panel.`,
      })
      return
    }

    ctx.views.hostStatic(url, options.distDir)
  }

  const entry: DevToolsViewIframe = {
    id: options.id,
    title: options.title,
    icon: options.icon,
    type: "iframe",
    url,
    ...(remote ? { remote: true } : {}),
  }
  ctx.docks.register(defineDockEntry(entry as never) as never)

  const result = { remote, url }
  if (ctxPanels) {
    ctxPanels.set(registryKey, result)
  }
  else {
    registeredPanels.set(ctx, new Map([[registryKey, result]]))
  }

  return result
}

function warnIfDevtoolsShellMissing(ctx: ViteDevToolsNodeContext, feature: ViteHubDevtoolsFeature): void {
  queueMicrotask(() => {
    if (registeredShells.has(ctx)) {
      return
    }

    const warnedFeatures = missingShellWarnings.get(ctx) ?? new Set<string>()
    if (warnedFeatures.has(feature.id)) {
      return
    }

    warnedFeatures.add(feature.id)
    missingShellWarnings.set(ctx, warnedFeatures)
    ctx.messages.add({
      level: "warn",
      message: `${feature.title} DevTools feature is enabled, but the ViteHub DevTools Integration is not installed. Add hubDevtools() from @vitehub/devtools to your Vite plugins.`,
    })
  })
}

export function registerViteHubDevtoolsFeature(
  ctx: ViteDevToolsNodeContext,
  feature: ViteHubDevtoolsFeature,
): ViteHubDevtoolsFeature {
  const ctxFeatures = registeredFeatures.get(ctx)
  const registered = ctxFeatures?.get(feature.id)
  if (registered) {
    return registered
  }

  if (ctxFeatures) {
    ctxFeatures.set(feature.id, feature)
  }
  else {
    registeredFeatures.set(ctx, new Map([[feature.id, feature]]))
  }

  warnIfDevtoolsShellMissing(ctx, feature)
  return feature
}

export function listViteHubDevtoolsFeatures(ctx: ViteDevToolsNodeContext): ViteHubDevtoolsFeature[] {
  return [...(registeredFeatures.get(ctx)?.values() ?? [])]
}

export function hubDevtools(options: HubDevtoolsOptions = {}): Plugin {
  return {
    name: "@vitehub/devtools/vite",
    devtools: {
      setup(ctx) {
        if (options.enabled === false) {
          return
        }

        registeredShells.add(ctx)
        registerViteHubDevtoolsPanel(ctx, {
          icon: options.icon || "ph:toolbox-duotone",
          id: viteHubDevtoolsPanelId,
          route: viteHubDevtoolsDefaultUrl,
          title: options.title || viteHubDevtoolsTitle,
        })

        ctx.rpc.register(defineRpcFunction({
          name: viteHubDevtoolsGetFeaturesRpc,
          type: "query",
          setup: () => ({ handler: () => listViteHubDevtoolsFeatures(ctx) }),
        }) as never)
      },
    },
  }
}

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcServerFunctions {
    [viteHubDevtoolsGetFeaturesRpc]: () => ViteHubDevtoolsFeature[]
  }
}
