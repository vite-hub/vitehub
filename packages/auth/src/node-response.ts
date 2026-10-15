import type { ServerResponse } from "node:http"

export async function sendWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status
  target.statusMessage = response.statusText
  // Older web runtimes expose only a combined Set-Cookie field. Split at
  // cookie names, never at the comma inside an Expires date.
  const setCookieHeaders = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : splitCombinedSetCookie(response.headers.get("set-cookie"))
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

function splitCombinedSetCookie(value: string | null): string[] {
  if (!value) return []
  const result: string[] = []
  let start = 0
  let inExpires = false
  for (let index = 0; index < value.length; index++) {
    if (value.slice(index, index + 8).toLowerCase() === "expires=") inExpires = true
    if (inExpires && value[index] === ";") inExpires = false
    if (value[index] !== "," || inExpires) continue
    const prefix = value.slice(start, index)
    const hasCookieAttribute = /;\s*(?:expires|path|domain|max-age|samesite|secure|httponly|partitioned)\s*=/i.test(prefix)
    if (hasCookieAttribute && /^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=/.test(value.slice(index + 1))) {
      result.push(prefix.trim())
      start = index + 1
    }
  }
  result.push(value.slice(start).trim())
  return result
}
