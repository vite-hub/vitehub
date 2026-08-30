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
  if (!response.ok) throw new Error(`Console request failed with status ${response.status}.`)
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

export async function loadConsoleKVPages(
  base: string,
  store: string,
  signal: AbortSignal,
  initial?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const pages: Record<string, unknown>[] = []
  const cursors = new Set<string>()
  let page = initial
  let hasMore = true
  while (hasMore) {
    page ??= record(await requestConsole(base, { query: { store }, signal }))
    if (!page) break
    pages.push(page)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    const cursor = typeof page.cursor === "string" ? page.cursor : undefined
    if (cursor === undefined || cursors.has(cursor)) {
      hasMore = false
      continue
    }
    cursors.add(cursor)
    page = record(await requestConsole(base, { query: { cursor, store }, signal }))
  }
  return pages
}
