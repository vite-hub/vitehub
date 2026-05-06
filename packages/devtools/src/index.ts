import { defineDockEntry } from "@vitejs/devtools-kit"

import type { DevToolsDockEntry, DevToolsViewIframe, ViteDevToolsNodeContext } from "@vitejs/devtools-kit"

export interface ViteHubDevtoolsPanelOptions {
  distDir: string
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

export function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value)
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

  if (!remote) {
    ctx.views.hostStatic(options.route, options.distDir)
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

  return { remote, url }
}
