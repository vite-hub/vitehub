import { viteHubBasePath, viteHubPageSessionPath, viteHubPageToolsAssets, viteHubPageToolsInlineScript, viteHubPageToolsMarker } from "../runtime/page-tools-shared.ts"
import { VITEHUB_APP_BASE_URL } from "./vite.ts"

import type { NitroServerKit } from "../nitro-kit.ts"

export interface ViteHubPageToolRoutesOptions {
  /** A module whose default export is `viteHubPageSessionHandler` from `@vite-hub/internal/runtime/page-tools`. */
  handler: string
  /** The directory with the built `loader.js`. */
  loader: string
  /** The prefix of the routes in the Nitro configuration, from `viteHubPageToolsBase(config).mount`. Default: none. */
  mount?: string
}

/**
 * Adds the session route `GET <mount>/_vitehub/page/session` and the loader script at
 * `<mount>/_vitehub/page/assets/loader.js` to a Nitro configuration. Each owner package of a page tool calls it from its
 * Vite plugin, so the routes exist without the Console. The first owner wins: a later call keeps the route and the asset
 * that are already there, because the page tools registry is shared by every copy of this package.
 */
export function addViteHubPageToolRoutes(kit: NitroServerKit, options: ViteHubPageToolRoutesOptions): void {
  const mount = options.mount ?? ""
  const route = `${mount}${viteHubPageSessionPath}`
  const assetsBase = `${mount}${viteHubPageToolsAssets}`
  const handlers = Array.isArray(kit.config.handlers) ? kit.config.handlers : []
  if (!handlers.some(handler => Object(handler) === handler && Reflect.get(Object(handler), "route") === route)) {
    kit.addHandler({ handler: options.handler, route })
  }
  const assets = Array.isArray(kit.config.publicAssets) ? [...kit.config.publicAssets] : []
  if (!assets.some(asset => Object(asset) === asset && Reflect.get(Object(asset), "baseURL") === assetsBase)) {
    // The loader URL has a version query, so a short cache is enough.
    assets.push({ baseURL: assetsBase, dir: options.loader, maxAge: 300 })
  }
  kit.config.publicAssets = assets
}

/** Where the page tools of an app are. */
export interface ViteHubPageToolsBase {
  /** The path of the app base in the browser, such as `/portal`. `""` at the root. */
  base: string
  /**
   * The prefix of the ViteHub routes in the Nitro configuration. Nitro serves its routes below its own `baseURL`, such
   * as Nuxt `app.baseURL`, so this is the part of `base` that Nitro does not add.
   */
  mount: string
}

function readString(value: unknown, key: string): string | undefined {
  const field: unknown = value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined
  return typeof field === "string" ? field : undefined
}

/**
 * The app base of a Vite configuration. ViteHub's application-base config field or `__VITEHUB_APP_BASE_URL__` constant
 * takes precedence over the Vite `base`; the Nuxt module sets both from `app.baseURL`. The Nitro base is `nitro.baseURL`, else
 * `NITRO_APP_BASE_URL`.
 */
export function viteHubPageToolsBase(config: unknown, env: Record<string, string | undefined> = process.env): ViteHubPageToolsBase {
  const define: unknown = config !== null && typeof config === "object" ? Reflect.get(config, "define") : undefined
  const defined = readString(define, "__VITEHUB_APP_BASE_URL__")
  let appBase = readString(config, "base")
  if (defined) {
    try {
      const value: unknown = JSON.parse(defined)
      if (typeof value === "string") appBase = value
    }
    catch {}
  }
  const base = viteHubBasePath(readString(config, VITEHUB_APP_BASE_URL) ?? appBase)
  const nitro: unknown = config !== null && typeof config === "object" ? Reflect.get(config, "nitro") : undefined
  const nitroBase = viteHubBasePath(readString(nitro, "baseURL") ?? env.NITRO_APP_BASE_URL)
  return { base, mount: nitroBase && (base === nitroBase || base.startsWith(`${nitroBase}/`)) ? base.slice(nitroBase.length) : base }
}

/**
 * Adds the page tools loader to the `index.html` of a single page app, for an owner's Vite `transformIndexHtml` hook.
 * The added module script loads `<base>/_vitehub/page/assets/loader.js` in the browser when the page has the hint: the
 * `?vitehub` query or the `vitehub-tools=1` cookie. It works where no server changes the HTML: in the Vite dev server,
 * and for a built `index.html` that a host serves as a static file. It returns `undefined` when the page already has
 * the loader, so several owner packages add one script. `base` is the Vite `base`, such as `/portal/`.
 */
export function viteHubPageToolsIndexHtml(html: string, base: string | undefined): string | undefined {
  if (html.includes(viteHubPageToolsMarker)) return undefined
  const script = viteHubPageToolsInlineScript(base)
  const index = html.search(/<\/body\s*>/i)
  return index === -1 ? `${html}${script}` : `${html.slice(0, index)}${script}${html.slice(index)}`
}
