export interface CDPBrowserConnection {
  endpoint: string
  headers?: Record<string, string>
  kind: "cdp"
  preferredTargetId?: string
}

export interface CloudflareBrowserBindingConnection {
  binding: unknown
  kind: "cloudflare-binding"
  preferredTargetId?: string
  sessionId: string
}

export type PlaywrightBrowserConnection = CDPBrowserConnection | CloudflareBrowserBindingConnection
