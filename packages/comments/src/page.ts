/** Name of the Realtime Definition that holds one presence room per page. */
/**
 * The scope of the threads that people pin on the app's pages with the overlay. Threads that app code starts in its
 * own UI use their own scope, such as `doc:42`.
 */
export const commentsPageScope = "pages"

export const commentsRealtimeDefinition = "comments"

/** The route prefix of the Comments API. */
export const commentsRoute = "/api/_vitehub/comments"

/** Mount Comments under the application path, ignoring Vite asset URLs such as a CDN origin. */
export function mountedCommentsRoute(base = "/"): string {
  return base.startsWith("/") && !base.startsWith("//") ? `${base.replace(/\/+$/, "")}${commentsRoute}` : commentsRoute
}

/** The prebuilt overlay lives in the API's assets directory, including on applications mounted below a path. */
export function commentsApiRoute(overlayURL: string): string {
  const path = new URL(overlayURL).pathname
  const index = path.lastIndexOf(`${commentsRoute}/assets/`)
  return index === -1 ? commentsRoute : `${path.slice(0, index)}${commentsRoute}`
}

/** The cookie that asks the server to add the overlay to HTML pages. It is a hint, never a credential. */
export const commentsHintCookie = "vitehub-comments"

/** The query parameter that turns comment mode on for a page. */
export const commentsHintQuery = "comments"

/**
 * The key of a page: its pathname without query or hash, and without a trailing slash except for `/`. Threads and
 * presence rooms belong to a page key.
 */
export function normalizeCommentPage(path: string): string {
  let pathname = path.split(/[?#]/, 1)[0] ?? ""
  if (!pathname.startsWith("/")) pathname = `/${pathname}`
  pathname = pathname.replace(/\/{2,}/g, "/")
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "")
  return pathname || "/"
}

/** The Realtime document id of the presence room of a page: `pages/<hash>`, a safe Workspace path for any page. */
export function commentRoom(page: string): string {
  // Two FNV-1a passes with different seeds: 64 bits, so page rooms do not collide in practice.
  let a = 0x811C9DC5
  let b = 0x01000193 ^ 0x5BD1E995
  for (let index = 0; index < page.length; index++) {
    const code = page.charCodeAt(index)
    a = Math.imul(a ^ code, 0x01000193) >>> 0
    b = Math.imul(b ^ code, 0x01000193 + 0x9E3779B9) >>> 0
  }
  return `pages/${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`
}
