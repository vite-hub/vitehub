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
