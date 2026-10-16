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
  let quote: string | undefined
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === quote) {
        quote = undefined
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (value.slice(index, index + 8).toLowerCase() === "expires=") inExpires = true
    if (inExpires && character === ";") inExpires = false
    if (character !== ",") continue
    // A cookie boundary is a comma followed by a cookie name and equals sign.
    // Check this before the Expires state so dates without a trailing semicolon
    // still allow the next cookie to be forwarded separately.
    if (/^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=/.test(value.slice(index + 1))
      && isKnownCookieAttribute(value.slice(start, index))) {
      result.push(value.slice(start, index).trim())
      start = index + 1
      inExpires = false
      continue
    }
    if (inExpires) continue
  }
  result.push(value.slice(start).trim())
  return result
}

function isKnownCookieAttribute(cookie: string): boolean {
  const attributes = cookie.match(/;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:=|\s|$)/g)
  if (!attributes?.length) return true
  const known = new Set(["expires", "max-age", "domain", "path", "samesite", "secure", "httponly", "partitioned", "priority"])
  return attributes.every(attribute => known.has(attribute.slice(1).trim().split(/[=\s]/, 1)[0]!.toLowerCase()))
}
