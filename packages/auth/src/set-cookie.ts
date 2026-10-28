/** Read separate cookies even when a Fetch runtime exposes only a combined field. */
export function readSetCookies(headers: Headers): string[] {
  return typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitCombinedSetCookie(headers.get("set-cookie"))
}

function splitCombinedSetCookie(value: string | null): string[] {
  if (!value) return []
  const result: string[] = []
  let start = 0
  let inExpires = false
  let quote = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (character === "\\") {
        escaped = true
      } else if (character === '"') {
        quote = false
      }
      continue
    }
    if (character === '"') {
      quote = true
      continue
    }
    if (value.slice(index, index + 8).toLowerCase() === "expires=") inExpires = true
    if (inExpires && character === ";") inExpires = false
    if (character !== ",") continue
    // A cookie boundary is a comma followed by a cookie name and equals sign.
    // Check this before the Expires state so dates without a trailing semicolon
    // still allow the next cookie to be forwarded separately.
    const remainder = value.slice(index + 1)
    if (/^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=/.test(remainder)
      && isKnownCookieAttribute(value.slice(start, index), /^\s/.test(remainder))) {
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

function isKnownCookieAttribute(cookie: string, hasBoundaryWhitespace: boolean): boolean {
  const attributes = cookie.match(/;\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:=|\s|$)/g)
  if (!attributes?.length) return true
  const known = new Set(["expires", "max-age", "domain", "path", "samesite", "secure", "httponly", "partitioned", "priority"])
  if (!attributes.every(attribute => known.has(attribute.slice(1).trim().split(/[=\s]/, 1)[0]!.toLowerCase()))) return false
  // A comma without whitespace can be part of a value-bearing attribute
  // (for example, `Path=/a,x=1`). Keep it intact unless the attribute is a
  // flag, where compact combined-cookie boundaries are unambiguous.
  const lastAttribute = attributes.at(-1)!.slice(1).trim()
  const lastSemicolon = cookie.lastIndexOf(";")
  if (lastSemicolon >= 0 && cookie.slice(lastSemicolon + 1).includes(",") && !/^expires\s*=/i.test(lastAttribute)) return false
  return hasBoundaryWhitespace || !lastAttribute.includes("=")
}
