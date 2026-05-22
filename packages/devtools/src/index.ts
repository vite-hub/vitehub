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

const registeredShellPanels = new WeakSet<ViteDevToolsNodeContext>()
const registeredFeatures = new WeakMap<ViteDevToolsNodeContext, Map<string, ViteHubDevtoolsFeature>>()
const registeredShells = new WeakSet<ViteDevToolsNodeContext>()
const missingShellWarnings = new WeakMap<ViteDevToolsNodeContext, Set<string>>()

function registerHostedViteHubDevtoolsShell(
  ctx: ViteDevToolsNodeContext,
  options: Required<Pick<HubDevtoolsOptions, "icon" | "title">>,
): void {
  if (registeredShellPanels.has(ctx)) {
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
  registeredShellPanels.add(ctx)
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
        registerHostedViteHubDevtoolsShell(ctx, {
          icon: options.icon || "ph:toolbox-duotone",
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
