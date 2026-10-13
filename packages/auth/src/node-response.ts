import type { ServerResponse } from "node:http"

export async function sendWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status
  target.statusMessage = response.statusText
  // Older web runtimes expose only a combined Set-Cookie field. Split at
  // cookie names, never at the comma inside an Expires date.
  const setCookieHeaders = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : (response.headers.get("set-cookie")?.split(/,(?=\s*[^\s=;,]+=)/).map(value => value.trim()) ?? [])
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie" && setCookieHeaders.length > 0) return
    target.appendHeader(key, value)
  })
  for (const value of setCookieHeaders) {
    target.appendHeader("set-cookie", value)
  }

  if (!response.body) {
    target.end()
    return
  }

  const reader = response.body.getReader()
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      target.write(Buffer.from(chunk.value))
    }
  }
  finally {
    target.end()
    reader.releaseLock()
  }
}
