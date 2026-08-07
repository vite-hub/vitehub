export interface CDPBrowserConnection {
  endpoint: string
  headers?: Record<string, string>
  kind: "cdp"
  preferredTargetId?: string
}

export const cloudflareBrowserTerminated: unique symbol = Symbol("vitehub.browser.cloudflare.terminated")

interface CloudflareBrowserBindingConnectionBase {
  [cloudflareBrowserTerminated]?: boolean
  binding: unknown
  kind: "cloudflare-binding"
  preferredTargetId?: string
}

interface CloudflareChromiumConnection extends CloudflareBrowserBindingConnectionBase {
  engine?: "chromium"
  sessionId: string
}

interface CloudflareKitesurfConnection extends CloudflareBrowserBindingConnectionBase {
  engine: "kitesurf"
  sessionId?: never
}

export type CloudflareBrowserBindingConnection = CloudflareChromiumConnection | CloudflareKitesurfConnection

export type PlaywrightBrowserConnection = CDPBrowserConnection | CloudflareBrowserBindingConnection
