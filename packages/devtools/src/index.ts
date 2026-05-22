import { defineDockEntry, defineRpcFunction } from "@vitejs/devtools-kit"

import type { DevToolsDockEntry, DevToolsViewIframe, ViteDevToolsNodeContext } from "@vitejs/devtools-kit"
import type { Plugin } from "vite"

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

function registerHostedViteHubDevtoolsShell(
  ctx: ViteDevToolsNodeContext,
  options: Required<Pick<HubDevtoolsOptions, "icon" | "title">>,
): void {
  const registry = getRegistry(ctx)
  if (registry.registeredShellPanel) {
    return
  }

  const entry: DevToolsViewIframe = {
    id: viteHubDevtoolsPanelId,
    title: options.title,
    icon: options.icon,
    type: "iframe",
    url: viteHubDevtoolsDefaultUrl,
    remote: true,
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
    devtools: {
      setup(ctx) {
        if (options.enabled === false) {
          return
        }

        getRegistry(ctx).registeredShell = true
        registerHostedViteHubDevtoolsShell(ctx, {
          icon: options.icon || "ph:toolbox-duotone",
          title: options.title || viteHubDevtoolsTitle,
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
