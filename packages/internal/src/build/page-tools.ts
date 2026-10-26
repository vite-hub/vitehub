import { viteHubPageSessionPath, viteHubPageToolsAssets } from "../runtime/page-tools-shared.ts"

import type { NitroServerKit } from "../nitro-kit.ts"

export interface ViteHubPageToolRoutesOptions {
  /** A module whose default export is `viteHubPageSessionHandler` from `@vite-hub/internal/runtime/page-tools`. */
  handler: string
  /** The directory with the built `loader.js`. */
  loader: string
}

/**
 * Adds the session route `GET /_vitehub/page/session` and the loader script at `/_vitehub/page/assets/loader.js` to a
 * Nitro configuration. Each owner package of a page tool calls it from its Vite plugin, so the routes exist without the
 * Console. The first owner wins: a later call keeps the route and the asset that are already there, because the page
 * tools registry is shared by every copy of this package.
 */
export function addViteHubPageToolRoutes(kit: NitroServerKit, options: ViteHubPageToolRoutesOptions): void {
  const handlers = Array.isArray(kit.config.handlers) ? kit.config.handlers : []
  if (!handlers.some(handler => Object(handler) === handler && Reflect.get(Object(handler), "route") === viteHubPageSessionPath)) {
    kit.addHandler({ handler: options.handler, route: viteHubPageSessionPath })
  }
  const assets = Array.isArray(kit.config.publicAssets) ? [...kit.config.publicAssets] : []
  if (!assets.some(asset => Object(asset) === asset && Reflect.get(Object(asset), "baseURL") === viteHubPageToolsAssets)) {
    // The loader URL has a version query, so a short cache is enough.
    assets.push({ baseURL: viteHubPageToolsAssets, dir: options.loader, maxAge: 300 })
  }
  kit.config.publicAssets = assets
}
