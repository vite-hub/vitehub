import { createRequire } from "node:module"
import { join } from "node:path"

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

/** The error that the build shows when Comments cannot run on the docs site. */
export class DocsCommentsSetupError extends Error {
  constructor(why: string, fix: string) {
    super(`[@vite-hub/docs] ${why} ${fix}`)
    this.name = "DocsCommentsSetupError"
  }
}

const optOut = "or set docs: { comments: false } in nuxt.config.ts."

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
 * site without `vite-hub/nuxt` has none unless it asks for them, which fails the build. `false` sets `comments: false`,
 * so the Console's default does not turn Comments on either. The dependency only sets defaults: the app's own
 * `vitehub.comments` wins.
 */
export async function docsCommentsDependencies(
  nuxt: ModuleOptionsNuxt & { options: { rootDir: string } },
  comments: boolean | DocsCommentsOptions | undefined,
): Promise<Record<string, { optional: true, defaults: { comments: boolean | DocsCommentsOptions } }>> {
  const vitehub = await viteHubModuleOptions(nuxt)
  if (comments === false) return vitehub ? { "vite-hub/nuxt": { optional: true, defaults: { comments: false } } } : {}
  if (!vitehub) {
    if (comments === undefined) return {}
    throw new DocsCommentsSetupError("docs.comments needs vite-hub/nuxt, which keeps the threads in a ViteHub Database.", `Add "vite-hub/nuxt" to modules, ${optOut}`)
  }
  if (!installed("@vite-hub/comments", nuxt.options.rootDir)) {
    throw new DocsCommentsSetupError("Docs sites on vite-hub/nuxt have Comments on, which needs @vite-hub/comments.", `Run \`pnpm add @vite-hub/comments\`, ${optOut}`)
  }
  if (Reflect.get(vitehub, "database") === false) {
    throw new DocsCommentsSetupError("Docs sites on vite-hub/nuxt have Comments on, which keeps threads in the Database, but vitehub sets database: false.", `Remove database: false, ${optOut}`)
  }
  return { "vite-hub/nuxt": { optional: true, defaults: { comments: comments === undefined || comments === true ? true : comments } } }
}
