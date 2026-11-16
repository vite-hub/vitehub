import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

import { ownModule } from "@vite-hub/internal/build/paths"
import { resolveViteHubProjectRoot, VITEHUB_APP_BASE_URL, VITEHUB_PREPARE, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { findContentEntry, toRuntimeModuleSpecifier } from "@vite-hub/source/vite"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

import type { Plugin } from "vite"

/** `vitehub({ seo })`. */
export interface SeoOptions {
  /**
   * Serve `/sitemap.xml` with every page that ViteHub can find: the Nuxt pages without a dynamic part, the static
   * prerender routes, the published Content pages with a URL, and the entries of `server/sitemap.ts`. It also serves
   * `/robots.txt` that names the sitemap, unless the app has its own. URLs start with `publicUrl`. `exclude` lists path
   * prefixes to leave out, such as `/admin`.
   */
  sitemap?: boolean | { exclude?: readonly string[] }
}

const sitemapModule = ".vitehub/nitro/seo/sitemap.mjs"
const robotsModule = ".vitehub/nitro/seo/robots.mjs"
const pagesModule = ".vitehub/nitro/seo/pages.mjs"

interface NitroSeoOptions {
  prerender?: { routes?: unknown }
  routeRules?: Record<string, unknown>
}

interface NitroSeoHost {
  options: NitroSeoOptions
  hooks: { hook(name: "build:before", callback: () => void): unknown }
  scannedHandlers?: ReadonlyArray<{ route?: string, middleware?: boolean }>
}

/** A page path that belongs in a sitemap: no dynamic part, no file extension, and not a server or internal path. */
export function isSitemapPage(path: string): boolean {
  return path.startsWith("/") && !/[:*()[\]]/.test(path) && !/\.[a-z\d]+$/i.test(path) && !/^\/(?:api|_[^/]*)(?:\/|$)/.test(path)
}

/** The static page paths of the Nitro config: prerender routes, and route rules with `prerender: true`. */
export function nitroSitemapPages(nitro: NitroSeoOptions): string[] {
  const routes = Array.isArray(nitro.prerender?.routes) ? nitro.prerender.routes.filter((route): route is string => typeof route === "string") : []
  const rules = Object.entries(nitro.routeRules ?? {}).filter(([, rule]) => rule !== null && typeof rule === "object" && Reflect.get(rule, "prerender") === true).map(([path]) => path)
  return [...routes, ...rules].filter(isSitemapPage)
}

function hasOwnRobots(root: string, publicDir: string | false, serverDirs: readonly string[]): boolean {
  if (publicDir !== false && existsSync(join(publicDir, "robots.txt"))) return true
  return [...serverDirs.map(directory => join(directory, "routes")), resolve(root, "routes")]
    .some(directory => existsSync(directory) && readdirSync(directory).some(name => /^robots\.txt(?:\.get)?\.[cm]?[jt]s$/.test(name)))
}

function normalizeExclude(exclude: readonly string[]): string[] {
  return exclude.map(prefix => `/${prefix.replace(/^\/+/, "").replace(/\/+$/, "")}`)
}

/**
 * Serves `/sitemap.xml` and `/robots.txt` for `vitehub({ seo: { sitemap } })`. The Nuxt integration passes the Nuxt
 * pages with `api.setPages()`; a Nitro module adds the static prerender routes.
 */
export function viteHubSeoPlugin(options: SeoOptions, publicUrl: string | undefined): Plugin & { api: { setPages(paths: readonly string[]): Promise<void> }, nitro: { name: string, setup(nitro: NitroSeoHost): Promise<void> } } {
  const sitemap = options.sitemap === true ? {} : options.sitemap || {}
  const exclude = normalizeExclude(sitemap.exclude ?? [])
  let projectRoot: string | undefined
  let nuxtPages: readonly string[] = []
  let nitroPages: readonly string[] = []
  const writePages = async () => {
    if (!projectRoot) return
    const pages = [...new Set([...nuxtPages, ...nitroPages])].sort()
    await writeFileIfChanged(resolve(projectRoot, pagesModule), `export default ${JSON.stringify(pages)}\n`)
  }
  return {
    name: "vite-hub/seo",
    api: {
      async setPages(paths) {
        nuxtPages = paths.filter(isSitemapPage)
        await writePages()
      },
    },
    nitro: {
      name: "vite-hub/seo",
      async setup(nitro) {
        nitroPages = nitroSitemapPages(nitro.options)
        await writePages()
        nitro.hooks.hook("build:before", () => {
          const route = nitro.scannedHandlers?.find(handler => !handler.middleware && handler.route === "/sitemap.xml")
          if (route) throw viteHubErrorDiagnostics.SEO_SITEMAP_ROUTE_EXISTS()
        })
      },
    },
    async config(config, env) {
      // SAFETY: ViteHub hosts add these private keys to Vite's user config before plugins read it.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[], [VITEHUB_APP_BASE_URL]?: string, [VITEHUB_PREPARE]?: true, nitro?: Record<string, unknown>, vitehubCliDiscovery?: true }
      const root = resolve(config.root ?? process.cwd())
      projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string" ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(root)
      if (env.command === "build" && !publicUrl && !viteConfig[VITEHUB_PREPARE] && !viteConfig.vitehubCliDiscovery) throw viteHubErrorDiagnostics.SEO_PUBLIC_URL_MISSING()
      const site = env.command === "build" ? publicUrl ?? null : null
      const configuredBase = viteConfig[VITEHUB_APP_BASE_URL] ?? config.base
      const base = configuredBase?.startsWith("/") && !configuredBase.startsWith("//") ? configuredBase : "/"
      const serverDirs = (viteConfig[VITEHUB_SERVER_DIRS] ?? ["server"]).map(directory => resolve(projectRoot!, directory))
      const appEntry = serverDirs.flatMap(directory => ["sitemap.ts", "sitemap.mts", "sitemap.js", "sitemap.mjs"].map(name => join(directory, name))).find(file => existsSync(file))
      const contentEntry = await findContentEntry({ projectRoot, serverDirs })
      const runtime = JSON.stringify(ownModule(import.meta.url, "seo/runtime"))
      const load = (file: string) => `() => import(${JSON.stringify(toRuntimeModuleSpecifier(file))}).then(module => module.default)`
      const contentLoader = contentEntry ? `, content: ${load(contentEntry)}` : ""
      await writePages()
      await writeFileIfChanged(resolve(projectRoot, sitemapModule), [
        `import { defineSitemapRoute } from ${runtime}`,
        `import pages from "./pages.mjs"`,
        "",
        `export default defineSitemapRoute({ site: ${JSON.stringify(site)}, base: ${JSON.stringify(base)}, pages, exclude: ${JSON.stringify(exclude)}${appEntry ? `, app: ${load(appEntry)}` : ""}${contentLoader} })`,
        "",
      ].join("\n"))
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addHandler({ handler: resolve(projectRoot, sitemapModule), method: "get", route: "/sitemap.xml" })
      // Below a base path, the app does not own the robots.txt of its host.
      const publicDir = config.publicDir === false ? false : resolve(root, config.publicDir ?? "public")
      if (base === "/" && !hasOwnRobots(root, publicDir, serverDirs)) {
        await writeFileIfChanged(resolve(projectRoot, robotsModule), [
          `import { defineRobotsRoute } from ${runtime}`,
          "",
          `export default defineRobotsRoute({ site: ${JSON.stringify(site)}${contentLoader} })`,
          "",
        ].join("\n"))
        kit.addHandler({ handler: resolve(projectRoot, robotsModule), method: "get", route: "/robots.txt" })
      }
      viteConfig.nitro = kit.config
    },
  }
}
