export interface CDPBrowserConnection {
  endpoint: string
  headers?: Record<string, string>
  kind: "cdp"
  preferredTargetId?: string
}

export const cloudflareBrowserTerminated: unique symbol = Symbol("vitehub.browser.cloudflare.terminated")

export interface CloudflareBrowserBindingConnection {
  [cloudflareBrowserTerminated]?: boolean
  binding: unknown
  kind: "cloudflare-binding"
  preferredTargetId?: string
  sessionId: string
}

export type PlaywrightBrowserConnection = CDPBrowserConnection | CloudflareBrowserBindingConnection
