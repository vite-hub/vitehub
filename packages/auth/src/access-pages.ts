import { authErrorDiagnostics } from "./error-diagnostics.ts"

import type { AuthPages } from "./nuxt-types.ts"

/** A static segment or `:name`. */
const pageSegment = /^(?:[^:*?+(){}/]+|:[A-Za-z_]\w*)$/

/**
 * Checks `access.pages`. The Nuxt module attaches the page guard to each pattern with an `appMiddleware` route rule,
 * and Nuxt merges the rules of all matching patterns so that the most specific pattern wins.
 *
 * Nuxt orders matches by their segments from the left: a static segment wins over `:name`, which wins over `**`.
 * Optional, repeated, and regex params and duplicate patterns break this order, because Nuxt then orders the matches by
 * position in `routeRules`. A `*` matches one segment in the middle of a pattern but every depth at its end, so
 * `access.pages` does not accept it. Only the patterns that keep the order pass, so a wider pattern never silently
 * replaces a narrower one.
 */
export function assertAuthPages(pages: unknown): asserts pages is AuthPages {
  if (typeof pages !== "object" || pages === null || Array.isArray(pages)) {
    throw authErrorDiagnostics.AUTH_PAGE_ROUTES_INVALID({ message: "`defineAuth()` access.pages must be an object of route patterns." })
  }
  const shapes = new Map<string, string>()
  for (const [path, mode] of Object.entries(pages)) {
    const invalid = (reason: string) => authErrorDiagnostics.AUTH_PAGE_ROUTES_INVALID({ message: `\`defineAuth()\` access.pages has ${JSON.stringify(path)}: ${JSON.stringify(mode)}. ${reason}` })
    if (mode !== "user" && mode !== "guest" && mode !== false) throw invalid("A value must be 'user', 'guest', or false.")
    const segments = path.split("/").slice(1)
    if (!path.startsWith("/") || (path !== "/" && !segments.every((segment, index) => pageSegment.test(segment) || (segment === "**" && index === segments.length - 1)))) {
      throw invalid("A key must start with `/` and have only static segments, `:name`, and a last `**`.")
    }
    // Two patterns that differ only in their param names, or in case, which Vue Router ignores by default, match the
    // same pages, so they have no order.
    const shape = segments.map(segment => segment.startsWith(":") ? ":" : segment.toLowerCase()).join("/")
    const same = shapes.get(shape)
    if (same !== undefined) throw invalid(`It matches the same pages as ${JSON.stringify(same)}. Keep one of them.`)
    shapes.set(shape, path)
  }
}
