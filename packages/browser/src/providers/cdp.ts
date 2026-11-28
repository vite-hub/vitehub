import { isPlainObject } from "@vite-hub/internal/object"
import { getViteHubErrorShape } from "@vite-hub/runtime"

import { browserErrorDiagnostics } from "../error-diagnostics.ts"
import { browserProviderError } from "../errors.ts"

import type { CDPBrowserConnection } from "../internal/connections.ts"
import type { BrowserDriver } from "../types.ts"

export interface CDPBrowserOptions {
  /**
   * The Chromium to connect to. A `ws://` or `wss://` URL is the browser WebSocket, such as a Browserless URL with its
   * token. An `http://` or `https://` URL is a Chromium that runs with `--remote-debugging-port`.
   */
  url: string
}

function readUrl(value: unknown): URL {
  const text = typeof value === "string" ? value.trim() : ""
  const url = URL.canParse(text) ? new URL(text) : undefined
  if (!url || !["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    throw browserErrorDiagnostics.BROWSER_CDP_URL_INVALID()
  }
  return url
}

function devtoolsUrl(base: URL, path: string): URL {
  const url = new URL(base)
  url.pathname = `${base.pathname.replace(/\/$/, "")}${path}`
  return url
}

async function readJson(response: Response, operation: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw browserProviderError("cdp", operation, { status: response.status })
  }
  const value: unknown = await response.json()
  if (!isPlainObject(value)) throw browserProviderError("cdp", operation)
  return value
}

async function browserSocketUrlOnEndpointHost(base: URL): Promise<string> {
  const version = await readJson(await fetch(devtoolsUrl(base, "/json/version")), "read the CDP version endpoint")
  const socket = typeof version.webSocketDebuggerUrl === "string" && URL.canParse(version.webSocketDebuggerUrl)
    ? new URL(version.webSocketDebuggerUrl)
    : undefined
  if (!socket) throw browserProviderError("cdp", "read webSocketDebuggerUrl from the CDP version endpoint")
  socket.protocol = base.protocol === "https:" ? "wss:" : "ws:"
  socket.host = base.host
  return socket.href
}

/**
 * Connects Browser Sessions to a remote Chromium over the Chrome DevTools Protocol. Each session of an HTTP endpoint
 * opens its own page and closes it at the end. A WebSocket endpoint, such as Browserless, gives each session its own
 * browser.
 */
export function cdpBrowser(options: CDPBrowserOptions): BrowserDriver<CDPBrowserConnection> {
  const base = readUrl(options?.url)
  const http = base.protocol === "http:" || base.protocol === "https:"
  let nextSession = 0
  return {
    features: {
      liveHandoff: false,
    },
    isolation: "provider",
    name: "cdp",
    async open(openOptions = {}) {
      if (openOptions.idleTimeoutMs !== undefined) {
        throw browserProviderError("cdp", "configure an idle timeout for a remote CDP browser")
      }
      const id = `cdp:${++nextSession}`
      if (!http) return { close() {}, connection: { endpoint: base.href, kind: "cdp" }, id }
      try {
        const endpoint = await browserSocketUrlOnEndpointHost(base)
        const target = await readJson(
          await fetch(`${devtoolsUrl(base, "/json/new").href}?about:blank`, { method: "PUT" }),
          "open a page target",
        )
        const targetId = typeof target.id === "string" ? target.id : undefined
        if (!targetId) throw browserProviderError("cdp", "open a page target")
        let closed = false
        return {
          async close() {
            if (closed) return
            closed = true
            const response = await fetch(devtoolsUrl(base, `/json/close/${encodeURIComponent(targetId)}`))
            void response.body?.cancel().catch(() => {})
          },
          connection: { endpoint, kind: "cdp", preferredTargetId: targetId },
          id: `${id}:${targetId}`,
        }
      }
      catch (error) {
        if (getViteHubErrorShape(error)?.code === "BROWSER_PROVIDER_ERROR") throw error
        throw browserProviderError("cdp", `connect to ${base.origin}`, { cause: error })
      }
    },
  }
}

export type { CDPBrowserConnection } from "../internal/connections.ts"
