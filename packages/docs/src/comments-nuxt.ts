import { createRequire } from "node:module"
import { join } from "node:path"

import { useLogger } from "@nuxt/kit"
import { formatDiagnostic } from "nostics"

import { docsErrorDiagnostics } from "./error-diagnostics.ts"
import { viteHubModuleOptions } from "./module-options.ts"

import type { ModuleOptionsNuxt } from "./module-options.ts"

/** Comments on a docs site: the `comments` option of `vite-hub/nuxt`, which these pass to. */
export interface DocsCommentsOptions {
  /** The Database Definition that keeps the threads. Default: the default or only Database. */
  database?: string
  /** SQL dialect of that Database. Default `sqlite`: SQLite, libSQL, and D1. */
  dialect?: "postgresql" | "sqlite"
  /** `false` leaves the overlay out of the pages. The Comments API, the operations, and the Console section stay. */
  overlay?: false
}

/** Whether the app can import `name`, as `vite-hub` resolves its optional peers. */
function installed(name: string, rootDir: string): boolean {
  try {
    createRequire(join(rootDir, "package.json")).resolve(`${name}/package.json`)
    return true
  }
  catch {
    return false
  }
}

/**
 * The module dependency that turns Comments on in `vite-hub/nuxt`. Comments keeps threads in a ViteHub Database, so a
 * site without `vite-hub/nuxt` has none unless it asks for them, which fails the build. `false` sets `comments: false`.
 * The dependency only sets defaults: the app's own `vitehub.comments` wins, so `false` with Comments on in `vitehub` warns.
 */
export async function docsCommentsDependencies(
  nuxt: ModuleOptionsNuxt & { options: { rootDir: string } },
  comments: boolean | DocsCommentsOptions | undefined,
): Promise<Record<string, { optional: true, defaults: { comments: boolean | DocsCommentsOptions } }>> {
  const vitehub = await viteHubModuleOptions(nuxt)
  if (comments === false && vitehub?.comments !== undefined && vitehub.comments !== false) {
    useLogger("@vite-hub/docs").warn(formatDiagnostic(docsErrorDiagnostics.DOCS_COMMENTS_OFF_IGNORED()))
  }
  if (comments === false) return vitehub ? { "vite-hub/nuxt": { optional: true, defaults: { comments: false } } } : {}
  if (!vitehub) {
    if (comments === undefined) return {}
    throw docsErrorDiagnostics.DOCS_COMMENTS_VITEHUB_MISSING()
  }
  if (vitehub.comments === false) return {}
  if (!installed("@vite-hub/comments", nuxt.options.rootDir)) {
    throw docsErrorDiagnostics.DOCS_COMMENTS_PACKAGE_MISSING()
  }
  if (Reflect.get(vitehub, "database") === false) {
    throw docsErrorDiagnostics.DOCS_COMMENTS_DATABASE_OFF()
  }
  return { "vite-hub/nuxt": { optional: true, defaults: { comments: comments === undefined || comments === true ? true : comments } } }
}
