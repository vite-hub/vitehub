export class ConsoleRequestError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Console request failed with status ${status}.`)
    this.name = "ConsoleRequestError"
    this.status = status
  }
}

export function isRetryableConsoleRequestError(error: unknown): boolean {
  return !(error instanceof ConsoleRequestError) || error.status >= 500
}

export async function requestConsole(
  path: string,
  options: { body?: unknown, method?: "GET" | "POST", query?: Record<string, unknown>, signal?: AbortSignal } = {},
): Promise<unknown> {
  const url = new URL(path, "http://vitehub.local")
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) value.forEach(entry => url.searchParams.append(key, String(entry)))
    else url.searchParams.set(key, String(value))
  }
  const request: RequestInit = {
    method: options.method ?? "GET",
    signal: options.signal,
  }
  if (options.body !== undefined) {
    request.body = JSON.stringify(options.body)
    request.headers = { "content-type": "application/json" }
  }
  const response = await fetch(`${url.pathname}${url.search}`, request)
  if (!response.ok) throw new ConsoleRequestError(response.status)
  return response.json()
}

export function appendUniqueConsoleKeys(existing: string[], page: string[]): string[] {
  return [...new Set([...existing, ...page])]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined
}

function assertConsolePage(page: Record<string, unknown>): void {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  const message = typeof page.error === "string" ? page.error : undefined
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  const code = typeof page.errorCode === "string" ? page.errorCode : undefined
  if (!message && !code) return
  const error = new Error(message ?? `Console request failed with error code ${code}.`)
  if (code) Object.assign(error, { code })
  throw error
}

export async function loadConsoleKVPages(
  base: string,
  store: string,
  signal: AbortSignal,
  initial?: Record<string, unknown>,
  options: { limit?: number, maxPages?: number, prefix?: string } = {},
): Promise<{ pages: Record<string, unknown>[], truncated: boolean }> {
  const pages: Record<string, unknown>[] = []
  const cursors = new Set<string>()
  let page = initial
  let hasMore = true
  while (hasMore && pages.length < (options.maxPages ?? Number.POSITIVE_INFINITY)) {
    page ??= record(await requestConsole(base, {
      query: { limit: options.limit, prefix: options.prefix, store },
      signal,
    }))
    if (!page) break
    assertConsolePage(page)
    pages.push(page)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    const cursor = typeof page.cursor === "string" ? page.cursor : undefined
    if (cursor === undefined) {
      hasMore = false
      continue
    }
    if (cursors.has(cursor)) break
    cursors.add(cursor)
    if (pages.length >= (options.maxPages ?? Number.POSITIVE_INFINITY)) break
    page = record(await requestConsole(base, {
      query: { cursor, limit: options.limit, prefix: options.prefix, store },
      signal,
    }))
  }
  return { pages, truncated: hasMore }
}
