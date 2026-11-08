import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

/** The fields that Console tests set on a request event. */
export interface ConsoleTestEvent {
  body?: unknown
  context?: { params?: Record<string, string | undefined> }
  env?: Record<string, unknown>
  headers?: ConstructorParameters<typeof Headers>[0]
  method?: string
  remoteAddress?: string
  res?: { headers?: Headers, status?: number }
  url: string
  waitUntil?: (promise: Promise<unknown>) => void
}

/** A Console request event with the Standard Context that the ViteHub Nitro plugin sets on each request. */
export function consoleEvent(input: ConsoleTestEvent): ConsoleRequestEvent {
  const method = input.method ?? (input.body === undefined ? "GET" : "POST")
  const body = input.body === undefined ? undefined : typeof input.body === "string" ? input.body : JSON.stringify(input.body)
  const headers = new Headers(input.headers)
  if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  return {
    ...(input.context ? { context: input.context } : {}),
    "~standard": {
      vendor: "test",
      req: new Request(new URL(input.url, "http://localhost"), { body, headers, method }),
      res: input.res ?? { headers: new Headers() },
      runtime: {
        ...(input.env ? { cloudflare: { env: input.env } } : {}),
        ...(input.remoteAddress ? { clientAddress: input.remoteAddress } : {}),
      },
      ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
    },
  }
}

/** A Console request event for an existing Web Request. `remoteAddress` is the peer address that the host reports. */
export function requestEvent(request: Request, extra: { context?: { params?: Record<string, string | undefined> }, remoteAddress?: string } = {}): ConsoleRequestEvent {
  const { remoteAddress, ...rest } = extra
  return { ...rest, "~standard": { vendor: "test", req: request, res: { headers: new Headers() }, ...(remoteAddress ? { runtime: { clientAddress: remoteAddress } } : {}) } }
}

/** The Node response of an H3 1 event, enough for Console code to write headers through Standard Context. */
export function nodeResponse() {
  const headers = new Map<string, number | string | string[]>()
  return {
    statusCode: 200,
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    getHeaders: () => Object.fromEntries(headers),
    removeHeader: (name: string) => { headers.delete(name.toLowerCase()) },
    setHeader: (name: string, value: number | string | string[]) => { headers.set(name.toLowerCase(), value) },
  }
}
