import { blobErrorDiagnostics } from "../error-diagnostics.ts"

// eslint-disable-next-line no-control-regex -- the check must match control characters.
const controlCharacters = /[\u0000-\u001F\u007F]/

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        index++
        continue
      }
      return true
    }
    if (code >= 0xDC00 && code <= 0xDFFF) return true
  }
  return false
}

function pathnameIssue(pathname: string, prefix: boolean): string | undefined {
  if (!pathname && !prefix) return "must not be empty"
  if (controlCharacters.test(pathname)) return "must not contain control characters"
  if (hasUnpairedSurrogate(pathname)) return "must contain well-formed Unicode"
  if (pathname.split(/[/\\]/).some(segment => segment === "." || segment === "..")) return "must not contain \".\" or \"..\" segments"
  return undefined
}

/**
 * Reject a decoded pathname that a driver, filesystem, or request URL could resolve to another object,
 * folder, or bucket. A list prefix can be empty.
 */
export function assertValidPathname(pathname: string, { prefix = false } = {}): string {
  const issue = pathnameIssue(pathname, prefix)
  if (issue) {
    // H3 reads `statusCode`, so a route that lets this error through answers 400.
    throw Object.assign(
      blobErrorDiagnostics.BLOB_R0034({ message: `Invalid blob ${prefix ? "prefix" : "pathname"} ${JSON.stringify(pathname)}: it ${issue}.` }),
      { statusCode: 400 },
    )
  }
  return pathname
}
