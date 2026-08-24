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

export function assertConsoleRequest(event: ConsoleRequestEvent): void {
  const method = event.method ?? event.req?.method ?? event.node?.req?.method
  if (method !== "GET") throw consoleRequestError(405, "Method not allowed")
}

export function consoleRequestURL(event: ConsoleRequestEvent): URL {
  const value = event.req?.url ?? event.node?.req?.url ?? "/"
  return value instanceof URL ? value : new URL(value, "http://localhost")
}
