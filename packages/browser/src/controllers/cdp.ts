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

type CDPMessage =
  | { kind: "event", method: string, params?: unknown, sessionId?: string }
  | { kind: "response", error?: { message: string }, id: number, result?: unknown, sessionId?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- CDP JSON is unknown until its object envelope is validated.
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- CDP JSON fields are unknown until their protocol type is validated.
  return typeof value === "string"
}

function isSafeInteger(value: unknown): value is number {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- CDP response ids are unknown JSON values until their numeric type is validated.
  return typeof value === "number" && Number.isSafeInteger(value)
}

function parseMessage(data: unknown): CDPMessage {
  const parsed: unknown = JSON.parse(String(data))
  if (!isRecord(parsed)) throw new TypeError("CDP message must be an object")

  if (Object.hasOwn(parsed, "id")) {
    if (!isSafeInteger(parsed.id) || Object.hasOwn(parsed, "method")) {
      throw new TypeError("CDP response id must be a safe integer")
    }
    const hasError = Object.hasOwn(parsed, "error")
    const hasResult = Object.hasOwn(parsed, "result")
    if (hasError === hasResult) throw new TypeError("CDP response must include exactly one result or error")
    if (hasResult && !isRecord(parsed.result)) {
      throw new TypeError("CDP response result must be an object")
    }
    let error: { message: string } | undefined
    if (hasError) {
      const candidate = parsed.error
      if (!isRecord(candidate) || !isString(candidate.message)) {
        throw new TypeError("CDP response error must include a message")
      }
      error = { message: candidate.message }
    }
    const sessionId = parsed.sessionId
    if (sessionId !== undefined && !isString(sessionId)) {
      throw new TypeError("CDP response sessionId must be a string")
    }
    const response: Extract<CDPMessage, { kind: "response" }> = {
      error,
      id: parsed.id,
      kind: "response",
      result: hasResult ? parsed.result : undefined,
    }
    if (sessionId !== undefined) response.sessionId = sessionId
    return response
  }

  if (!isString(parsed.method) || !parsed.method) throw new TypeError("CDP event method must be a non-empty string")
  if (Object.hasOwn(parsed, "params") && !isRecord(parsed.params)) {
    throw new TypeError("CDP event parameters must be an object")
  }
  const sessionId = parsed.sessionId
  if (sessionId !== undefined && !isString(sessionId)) {
    throw new TypeError("CDP event sessionId must be a string")
  }
  const event: Extract<CDPMessage, { kind: "event" }> = {
    kind: "event",
    method: parsed.method,
    params: parsed.params,
  }
  if (sessionId !== undefined) event.sessionId = sessionId
  return event
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
      let releasing = false
      let releasePromise: Promise<void> | undefined
      const pending = new Map<number, { reject(error: unknown): void, resolve(value: unknown): void }>()
      const listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
      const rejectPending = (error: unknown) => {
        for (const request of pending.values()) request.reject(error)
        pending.clear()
      }
      socket.addEventListener("message", (event) => {
        let message: CDPMessage
        try {
          message = parseMessage("data" in event ? event.data : undefined)
        }
        catch (cause) {
          rejectPending(browserProviderError("cdp", "parse a protocol message", { cause }))
          return
        }
        if (message.kind === "event") {
          for (const listener of listeners.get(message.method) ?? []) {
            listener(message.params, message.sessionId)
          }
          return
        }
        if (message.id < 1 || message.id > nextId) {
          rejectPending(browserProviderError("cdp", "parse a protocol message", {
            cause: new TypeError("CDP response id was never sent"),
          }))
          return
        }
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if (message.error) request.reject(browserProviderError("cdp", message.error.message || "run a CDP command"))
        else request.resolve(message.result)
      })
      socket.addEventListener("close", () => {
        rejectPending(browserProviderError("cdp", "complete a command before disconnect"))
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
            if (releasing) throw browserProviderError("cdp", "send a command after release")
            return await new Promise<TResult>((resolve, reject) => {
              const id = ++nextId
              pending.set(id, { reject, resolve: value => resolve(value as TResult) })
              socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
            })
          },
        },
        preservesSessionOnRelease: true,
        release() {
          releasing = true
          listeners.clear()
          releasePromise ??= Promise.resolve().then(async () => {
            if (socket.readyState === 3) return
            await new Promise<void>((resolve, reject) => {
              const onClose = () => resolve()
              socket.addEventListener("close", onClose, { once: true })
              try {
                if (socket.readyState < 2) socket.close()
              }
              catch (error) {
                socket.removeEventListener("close", onClose)
                reject(error)
              }
            })
          }).catch((error) => {
            releasePromise = undefined
            throw error
          })
          return releasePromise
        },
      }
    },
  }
}

export type { PlaywrightBrowserConnection } from "../internal/connections.ts"
