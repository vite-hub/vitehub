export async function requestConsole(
  path: string,
  options: { query?: Record<string, unknown>, signal?: AbortSignal } = {},
): Promise<unknown> {
  const url = new URL(path, "http://vitehub.local")
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) value.forEach(entry => url.searchParams.append(key, String(entry)))
    else url.searchParams.set(key, String(value))
  }
  const response = await fetch(`${url.pathname}${url.search}`, { signal: options.signal })
  if (!response.ok) throw new Error(`Console request failed with status ${response.status}.`)
  return response.json()
}
