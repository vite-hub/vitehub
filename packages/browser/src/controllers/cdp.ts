import { browserProviderError } from "../errors.ts"

import type { BrowserController } from "../types.ts"
import type { PlaywrightBrowserConnection } from "../internal/connections.ts"

interface CDPSocket extends EventTarget {
  accept?(): void
  close(code?: number, reason?: string): void
  readyState: number
  send(data: string): void
}

export interface CDPClient {
  on(method: string, listener: (params: unknown, sessionId?: string) => void): () => void
  send<TResult = unknown>(method: string, params?: object, sessionId?: string): Promise<TResult>
}

export interface CDPControllerOptions {
  connect?: (connection: PlaywrightBrowserConnection) => Promise<CDPSocket>
}

async function cloudflareSocket(
  connection: Extract<PlaywrightBrowserConnection, { kind: "cloudflare-binding" }>,
): Promise<CDPSocket> {
  const binding = connection.binding as { fetch?: typeof fetch }
  if (typeof binding?.fetch !== "function") {
    throw browserProviderError("cdp", "connect through the Cloudflare Browser binding")
  }
  const url = new URL("http://fake.host/v1/devtools/browser")
  if (connection.engine === "kitesurf") url.searchParams.set("browser", "kitesurf")
  else url.pathname += `/${encodeURIComponent(connection.sessionId)}`
  const response = await binding.fetch(url, {
    headers: {
      "cf-brapi-client": "@vite-hub/browser",
      Upgrade: "websocket",
    },
  }) as Response & { webSocket?: CDPSocket | null }
  if (!response.webSocket) {
    throw browserProviderError("cdp", "connect through the Cloudflare Browser binding", { status: response.status })
  }
  response.webSocket.accept?.()
  return response.webSocket
}

async function localSocket(
  connection: Extract<PlaywrightBrowserConnection, { kind: "cdp" }>,
): Promise<CDPSocket> {
  if (connection.headers && Object.keys(connection.headers).length > 0) {
    throw browserProviderError("cdp", "connect with authenticated WebSocket headers")
  }
  const socket = new WebSocket(connection.endpoint)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(browserProviderError("cdp", "connect to the browser")), { once: true })
  })
  return socket
}

async function connect(connection: PlaywrightBrowserConnection): Promise<CDPSocket> {
  return connection.kind === "cloudflare-binding" ? cloudflareSocket(connection) : localSocket(connection)
}

export function cdp(options: CDPControllerOptions = {}): BrowserController<CDPClient, PlaywrightBrowserConnection> {
  return {
    features: { attachExistingSession: true },
    name: "cdp",
    async attach(connection) {
      const socket = await (options.connect || connect)(connection)
      let nextId = 0
      let released = false
      const pending = new Map<number, { reject(error: unknown): void, resolve(value: unknown): void }>()
      const listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String((event as MessageEvent).data)) as {
          error?: { message?: string }
          id?: number
          method?: string
          params?: unknown
          result?: unknown
          sessionId?: string
        }
        if (!message.id) {
          if (message.method) {
            for (const listener of listeners.get(message.method) ?? []) {
              listener(message.params, message.sessionId)
            }
          }
          return
        }
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if (message.error) request.reject(browserProviderError("cdp", message.error.message || "run a CDP command"))
        else request.resolve(message.result)
      })
      socket.addEventListener("close", () => {
        for (const request of pending.values()) request.reject(browserProviderError("cdp", "complete a command before disconnect"))
        pending.clear()
      })

      return {
        client: {
          on(method, listener) {
            const methodListeners = listeners.get(method) ?? new Set()
            methodListeners.add(listener)
            listeners.set(method, methodListeners)
            return () => {
              methodListeners.delete(listener)
              if (methodListeners.size === 0) listeners.delete(method)
            }
          },
          async send<TResult>(method: string, params: object = {}, sessionId?: string): Promise<TResult> {
            if (released) throw browserProviderError("cdp", "send a command after release")
            return await new Promise<TResult>((resolve, reject) => {
              const id = ++nextId
              pending.set(id, { reject, resolve: value => resolve(value as TResult) })
              socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
            })
          },
        },
        preservesSessionOnRelease: true,
        async release() {
          if (released) return
          released = true
          listeners.clear()
          if (socket.readyState >= 2) return
          await new Promise<void>((resolve) => {
            socket.addEventListener("close", () => resolve(), { once: true })
            socket.close()
          })
        },
      }
    },
  }
}

export type { PlaywrightBrowserConnection } from "../internal/connections.ts"
