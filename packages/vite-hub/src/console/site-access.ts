import { ownerModules } from "../internal/owner-modules.ts"

/** The `comments` option of `vitehub()`, as far as Site access reads it. */
export type ConsoleSiteComments = boolean | { overlay?: false | object } | undefined

/**
 * Whether the app has Site access: the Comments pill, which reads the person of the site cookie. Comments is on with
 * `server/comments.ts` or the `comments` option, and `overlay: false` leaves the pill out. Vite and Nuxt read this one
 * value for the `/_vitehub/site` route, the `/_vitehub/<page>` route, and the `site` section of the Console.
 */
export function resolveConsoleSiteAccess(comments: ConsoleSiteComments, options: { projectRoot: string, serverDirs?: readonly string[] }): boolean {
  const commentsVite = ownerModules.commentsVite
  if (comments === false || !commentsVite) return false
  if (typeof comments === "object" && comments.overlay === false) return false
  return Boolean(comments) || commentsVite.findCommentsEntry(options.projectRoot, options.serverDirs) !== undefined
}
