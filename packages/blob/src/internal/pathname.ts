import { blobErrorDiagnostics } from "../error-diagnostics.ts"

// eslint-disable-next-line no-control-regex -- the check must match control characters.
const controlCharacters = /[\u0000-\u001F\u007F]/
// Methods decode a pathname once. A decoded pathname with `%XX` would decode again when passed back, and target another object.
const percentEncoded = /%[\da-f]{2}/i

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

/** Returns why a decoded pathname is unsafe, or `undefined` when it is valid. A list prefix can be empty. */
export function pathnameIssue(pathname: string, { prefix = false } = {}): string | undefined {
  if (!pathname && !prefix) return "must not be empty"
  if (controlCharacters.test(pathname)) return "must not contain control characters"
  if (hasUnpairedSurrogate(pathname)) return "must contain well-formed Unicode"
  if (percentEncoded.test(pathname)) return "must not contain \"%\" followed by two hex digits after decoding"
  if (pathname.split(/[/\\]/).some(segment => segment === "." || segment === "..")) return "must not contain \".\" or \"..\" segments"
  return undefined
}

/**
 * Reject a decoded pathname that a driver, filesystem, or request URL could resolve to another object,
 * folder, or bucket. A list prefix can be empty.
 */
export function assertValidPathname(pathname: string, { prefix = false } = {}): string {
  const issue = pathnameIssue(pathname, { prefix })
  if (issue) {
    // H3 reads `statusCode`, so a route that lets this error through answers 400.
    throw Object.assign(
      blobErrorDiagnostics.BLOB_R0034({ message: `Invalid blob ${prefix ? "prefix" : "pathname"} ${JSON.stringify(pathname)}: it ${issue}.` }),
      { statusCode: 400 },
    )
  }
  return pathname
}

function joinPath(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
}

// Expects pathname already normalized via normalizePathname.
function splitPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean)
  const filename = segments.pop() || ""
  const dotIndex = filename.lastIndexOf(".")

  return {
    dir: segments.join("/"),
    ext: dotIndex > 0 ? filename.slice(dotIndex) : "",
    name: dotIndex > 0 ? filename.slice(0, dotIndex) : filename,
  }
}

/** Applies `prefix` and `addRandomSuffix` as `put()` does, then checks the final pathname. */
export function normalizeBlobPath(pathname: string, options: { addRandomSuffix?: boolean, prefix?: string }) {
  const { dir, ext, name } = splitPath(pathname)
  const filename = options.addRandomSuffix
    ? `${name}-${globalThis.crypto.randomUUID().split("-")[0]}${ext}`
    : `${name}${ext}`
  const normalized = joinPath(dir, filename)
  // The prefix and the suffix can change the pathname, so check the final value.
  return assertValidPathname(options.prefix
    ? joinPath(options.prefix, normalized)
    : normalized)
}

// Decode the pathname once. A pathname that is not valid percent-encoding stays as it is.
export function decodePathname(pathname: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  }
  catch {
    decoded = pathname
  }
  return decoded.replace(/^\/+/, "")
}
