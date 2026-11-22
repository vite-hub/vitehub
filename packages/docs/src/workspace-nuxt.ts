import { docsErrorDiagnostics } from "./error-diagnostics.ts"
import { viteHubModuleOptions } from "./module-options.ts"

import type { ModuleOptionsNuxt } from "./module-options.ts"

/**
 * The `webContainer` defaults of `vite-hub/nuxt` for the pages that run a WebContainer. `vite-hub/nuxt` sends the
 * cross-origin isolation headers on these routes only. The defaults merge with the app's own `vitehub.webContainer.routes`,
 * and they reach `vite-hub/nuxt` in either module order. Without such pages there are none.
 */
export async function docsWebContainerDefaults(nuxt: ModuleOptionsNuxt, routes: readonly string[]): Promise<{ webContainer: { routes: string[] } } | undefined> {
  if (routes.length === 0) return undefined
  if (!await viteHubModuleOptions(nuxt)) throw docsErrorDiagnostics.DOCS_WORKSPACE_VITEHUB_MISSING({ pages: routes })
  return { webContainer: { routes: [...routes] } }
}
