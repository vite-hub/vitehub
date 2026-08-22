const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
const localHosts = new Set(["127.0.0.1", "::1", "localhost"])
const proxyHeaders = [
  "cf-connecting-ip",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-server",
  "x-real-ip",
]

interface ConsoleHeaders {
  get(name: string): string | null
}

export interface ConsoleRequestEvent {
  context?: {
    clientAddress?: string
    params?: Record<string, string | undefined>
  }
  headers?: ConsoleHeaders
  method?: string
  node?: {
    req?: {
      method?: string
      socket?: { remoteAddress?: string }
      url?: string
    }
  }
  req?: {
    context?: { clientAddress?: string }
    ip?: string
    headers?: ConsoleHeaders
    method?: string
    url?: string | URL
  }
}

function consoleRequestError(statusCode: number, statusMessage: string): Error {
  return Object.assign(new Error(statusMessage), { statusCode, statusMessage })
}

function requestHostname(host: string | undefined): string | undefined {
  if (!host) return
  try {
    return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "")
  }
  catch {
    return
  }
}

function assertLoopbackConsolePeer(event: ConsoleRequestEvent, rejectForwarded: boolean): void {
  const address = event.node?.req?.socket?.remoteAddress
  if (!address || !loopbackAddresses.has(address)) {
    throw consoleRequestError(404, "Not found")
  }
  const headers = event.headers ?? event.req?.headers
  if (rejectForwarded && headers && proxyHeaders.some(name => headers.get(name) !== null)) {
    throw consoleRequestError(404, "Not found")
  }
  const hostname = requestHostname(headers?.get("host") ?? undefined)
  if (!hostname || !localHosts.has(hostname)) throw consoleRequestError(404, "Not found")
}

export function assertLocalConsolePeer(event: ConsoleRequestEvent): void {
  assertLoopbackConsolePeer(event, true)
}

export function assertLocalConsoleRequest(event: ConsoleRequestEvent): void {
  const method = event.method ?? event.req?.method ?? event.node?.req?.method
  if (method !== "GET") throw consoleRequestError(405, "Method not allowed")
  // Nuxt has already applied assertLocalConsolePeer before its development proxy adds forwarding headers.
  assertLoopbackConsolePeer(event, false)
}

export function consoleRequestURL(event: ConsoleRequestEvent): URL {
  const value = event.req?.url ?? event.node?.req?.url ?? "/"
  return value instanceof URL ? value : new URL(value, "http://localhost")
}
