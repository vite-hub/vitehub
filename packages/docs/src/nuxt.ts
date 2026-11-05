import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import {
  addComponent,
  addComponentsDir,
  addImportsDir,
  addPlugin,
  addRouteMiddleware,
  addServerHandler,
  addTemplate,
  createResolver,
  defineNuxtModule,
  extendPages,
  useLogger,
} from "@nuxt/kit"
import { findContentEntry } from "@vite-hub/source/vite"
import { defu } from "defu"

import { setupDocsAssistant } from "./assistant-nuxt.ts"
import { docsCommentsDependencies, type DocsCommentsOptions } from "./comments-nuxt.ts"
import { readModuleOptions } from "./module-options.ts"
import { createDocsManifest } from "./manifest.ts"
import { docsAppPath, docsManifestPages, docsPageIcon, docsRailIcon, docsRawFile, docsRawPath, docsSectionIcon, normalizeDocsBase, type DocsIcons, type DocsLink } from "./navigation.ts"
import { toRawMarkdown } from "./raw.ts"
import { coversDocsPages } from "./page.ts"
import { docsAppConfigUi, vercelTheme, type DocsThemeUi } from "./theme.ts"

import type { DocsPage } from "./types.ts"

export { DocsAssistantSetupError } from "./assistant-nuxt.ts"
export { DocsCommentsSetupError } from "./comments-nuxt.ts"
export type { DocsCommentsOptions } from "./comments-nuxt.ts"

export interface DocsSiteOptions {
  /** Name in titles, the rail, and llms.txt. */
  name?: string
  /** Canonical origin, such as `https://vitehub.dev`. Raw Markdown links, canonical links, and the sitemap use it. */
  url?: string
  description?: string
  /** Path of a one-color SVG mark beside the name. The theme fills it with the text color. */
  logo?: string
  /** A short label after the name, such as `beta`, with an optional tooltip on the header brand. */
  badge?: { label: string, tooltip?: string }
}

export interface DocsStartOptions {
  /** Id of the section that new readers open first, such as `getting-started`. */
  section: string
  /**
   * Site pages listed at the top of the start section, such as a tutorials catalog. They open inside the start section,
   * and the header and the error page link to them. A link to the docs base reads "All docs" there.
   */
  links?: DocsLink[]
}

export interface DocsModuleOptions {
  /** Folder of Markdown pages, relative to the app root. Defaults to `content`. */
  dir?: string
  /** URL prefix whose folders are sections in the rail. Defaults to `/docs`. */
  base?: string
  site?: DocsSiteOptions
  /** Order of section categories in the rail and the catalog. Sections of other categories come after them in the rail. */
  categories?: string[]
  /** Categories that the catalog lists but the rail leaves out, such as shared reference topics. */
  railExclude?: string[]
  start?: DocsStartOptions
  /** Community links at the foot of the sidebar, such as a chat server. GitHub comes from `github`. */
  socials?: DocsLink[]
  /** One line above every docs page, such as a release status. */
  banner?: string
  /** More paths for `/sitemap.xml`, such as app pages outside the content folder. Every docs page is listed already. */
  sitemap?: string[]
  /** The repository of the site. `dir` is the content folder inside the repository. */
  github?: { repo: string, branch?: string, dir?: string } | false
  /** Icon maps of the rail and the sidebar. */
  icons?: Partial<DocsIcons>
  /**
   * The docs MCP server at `/mcp`, with `list-pages` and `get-page` tools. `name` is the server name that page actions
   * suggest, and `guide` is the page that explains how to connect it. `false` turns it off.
   */
  mcp?: { name?: string, guide?: string } | false
  /**
   * Checks links on prerendered pages with `nuxt-link-checker` and fails the build on detected errors.
   * Fragment checks are limited to the current page; fragments on other pages are not validated.
   * Remote URLs are not fetched. Set the app's own `linkChecker` options to change that. `false` turns the check off.
   */
  linkChecker?: false
  /** The docs assistant: an Agent that answers from these pages. `true` uses the Agent named `docs`. */
  assistant?: boolean | { agent?: string }
  /**
   * ViteHub Comments on every page, through `vite-hub/nuxt`. On by default when the app installs `vite-hub/nuxt`: the
   * module sets its `comments` option to `true`, or to these options. Threads belong to the page path, and the Console
   * lists them. `false` turns Comments off.
   */
  comments?: boolean | DocsCommentsOptions
  /**
   * Rewrites a page's Markdown before it becomes the copy that agents read at `/raw/<page>.md`, for example to expand
   * a component into plain Markdown. The built-in rewrites run after it. Runs at build time.
   */
  rawMarkdown?: (markdown: string, page: DocsPage) => string | Promise<string>
  /**
   * The share image of every page, rendered by `nuxt-og-image` while the build prerenders. By default it shows the
   * site, the page title and description, and the section. `component` names the app's own template in
   * `components/OgImage/`, such as `Docs` for `OgImage/Docs.takumi.vue`; it gets the same props. A page sets
   * `seo.image` to use a file of its own, or `false` for none. `false` here turns the images off.
   */
  ogImage?: false | { component?: string }
  /**
   * Path of a module, relative to the app root, whose default export is the parser options, such as
   * `{ plugins: [tabs()] }`. Comark plugins are functions, so they reach the server through a file and not through
   * this config. The page route, search, and Console drafts parse with it.
   */
  parser?: string
}

/** Options as the client and the server read them from `runtimeConfig.public.docs`. */
export interface DocsPublicConfig {
  appBase: string
  base: string
  site: { name: string, url: string, description: string, logo: string | null, badge: { label: string, tooltip: string | null } | null }
  categories: string[]
  railExclude: string[]
  /** Absent without a `start` option. Nuxt turns a `null` in runtime config into an empty string. */
  start?: { section: string, links: DocsLink[] }
  socials: DocsLink[]
  banner: string | null
  sitemap: string[]
  github: { repo: string, branch: string, dir: string, url: string } | false
  icons: DocsIcons
  mcp: { name: string, url: string, guide: string | null } | false
  assistant: { agent: string } | false
  ogImage: { component: string } | false
}

interface DiscoveryLink {
  href: string
  anchor?: string
}

interface DiscoveryRuntime {
  agentDiscovery?: { links: DiscoveryLink[] }
  public?: { agentDiscovery?: { resources: DiscoveryLink[] } }
}

interface NitroOptions {
  runtimeConfig?: DiscoveryRuntime
  routeRules?: Record<string, { headers?: Record<string, string> }>
  alias?: Record<string, string>
  serverAssets?: Array<{ baseName: string, dir: string, pattern?: string }>
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean, maxAge?: number }>
  prerender?: { crawlLinks?: boolean, autoSubfolderIndex?: boolean, routes?: string[] }
  experimental?: { asyncContext?: boolean }
  externals?: { inline?: Array<string | RegExp> | boolean }
}

interface AgentDiscoveryOptions {
  siteUrl?: string
  source?: string
  siteName?: string
  routes?: Array<string | { path: string, raw?: string }>
  discovery?: { links?: Array<{ href: string, rel: string, type?: string, title?: string, anchor?: string }>, mcpServerCard?: false | { endpoint: string, name?: string } }
}

interface LlmsOptions {
  domain?: string
  title?: string
  description?: string
  full?: { title?: string, description?: string }
}

/** Options of the modules that the docs module installs. Their own option types load only with their runtime. */
interface DocsNuxtOptions {
  rootDir: string
  appConfig: { ui?: DocsThemeUi }
  _layers: ReadonlyArray<{ config: { appConfig?: { ui?: DocsThemeUi } } }>
  runtimeConfig: { public: { mdc?: unknown } }
  agentDiscovery?: AgentDiscoveryOptions
  llms?: LlmsOptions
  linkChecker?: { excludeLinks?: Array<string | RegExp> }
}

export interface DocsNuxtModule {
  (inlineOptions: DocsModuleOptions, nuxt: never): unknown
  getMeta?: () => Promise<Record<string, unknown>>
}

const docsNuxtModule: DocsNuxtModule = defineNuxtModule<DocsModuleOptions>({
  meta: { configKey: "docs", name: "@vite-hub/docs" },
  defaults: {},
  // Nuxt installs these after this module, so the options that the setup writes reach them. Most resolve from this
  // package, so the app does not list them. nuxt-agent-discovery feeds nuxt-llms only when nuxt-llms comes first.
  moduleDependencies: async (nuxt) => {
    // Nuxt passes the inline options only to setup, so read them from the `modules` entry too.
    // SAFETY: the `docs` key and the inline entry options of this module are its options.
    const docs = (await readModuleOptions(nuxt, ["@vite-hub/docs", "@vite-hub/docs/nuxt", "vite-hub/docs/nuxt"], "docs") ?? {}) as DocsModuleOptions
    return {
      // Comments keeps threads in a ViteHub Database, so it runs through `vite-hub/nuxt`, which the app installs.
      ...await docsCommentsDependencies(nuxt, docs.comments),
      // Pages render with Nuxt UI prose components, and search and the outline are Nuxt UI content components.
      // A peer dependency: the app's own copy, so the app and the shell share one Nuxt UI.
      "@nuxt/ui": { defaults: { prose: true, content: true } },
      [dependency("@vite-hub/ui/nuxt")]: {},
      [dependency("nuxt-llms")]: {},
      [dependency("nuxt-agent-discovery")]: {},
      // Site name, URL, and description for every Nuxt SEO module: the link checker, share images, and Schema.org.
      [dependency("nuxt-site-config")]: { defaults: { name: docs.site?.name ?? "Docs", url: docs.site?.url, description: docs.site?.description, defaultLocale: "en" } },
      // Images render while the build prerenders, so the server bundle carries no renderer and a Worker stays small.
      // Disabled setup still registers the no-op composable imported by useDocsSeo.
      [dependency("nuxt-og-image")]: { defaults: { enabled: docs.ogImage !== false, zeroRuntime: true, defaults: { width: 1200, height: 630 } } },
      [dependency("nuxt-schema-org")]: {},
      ...docs.linkChecker === false ? {} : { [dependency("nuxt-link-checker")]: { defaults: { failOnError: true, fetchRemoteUrls: false, showLiveInspections: false } } },
      // The toolkit's own llms.txt block repeats what nuxt-agent-discovery writes.
      ...docs.mcp === false ? {} : { [dependency("@nuxtjs/mcp-toolkit")]: { defaults: { name: docs.site?.name ?? "Docs", llms: false } } },
    }
  },
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const runtime = resolver.resolve("./runtime")
    // Nuxt transpiles the package of the module path it loaded. Through `vite-hub/docs/nuxt` that is `vite-hub`, so the
    // runtime of this package, which imports `#imports`, must be listed itself.
    const packageRoot = resolver.resolve("..")
    nuxt.options.build.transpile.push(packageRoot)
    // Nuxt auto-imports composables only outside node_modules. The shell components use them, so an app that installs
    // this package needs its files included, or they fail with `useRoute is not defined`.
    const transform = nuxt.options.imports.transform ??= {}
    transform.include ??= []
    transform.include.push(new RegExp(`^${packageRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`))
    const contentDir = resolve(nuxt.options.rootDir, options.dir ?? "content")
    const rawDir = join(nuxt.options.buildDir, "docs/raw")
    const config = publicConfig(options, nuxt.options.app.baseURL)
    nuxt.options.runtimeConfig.public.docs = config
    setupDocsAssistant(nuxt, config)
    // The panel calls `useChat()` from `vite-hub/nuxt`, so without the assistant `DocsAssistant` renders nothing.
    addComponent({ name: "DocsAssistant", filePath: join(runtime, config.assistant ? "app/assistant/DocsAssistant.vue" : "app/assistant/DocsAssistantOff.vue") })
    if (config.assistant) addComponent({ name: "DocsAssistantPanel", filePath: join(runtime, "app/assistant/DocsAssistantPanel.vue") })
    const moduleOptions: DocsNuxtOptions = nuxt.options

    let manifest = createDocsManifest({ dir: contentDir, base: config.base })
    /** Writes the agent copy of every page. `nuxi build` empties the build folder after the modules load, so it runs before the build. */
    async function writeRaw(snapshot = manifest) {
      rmSync(rawDir, { force: true, recursive: true })
      for (const page of docsManifestPages(snapshot)) {
        const target = join(rawDir, docsRawFile(page.path))
        mkdirSync(dirname(target), { recursive: true })
        const source = readFileSync(join(contentDir, page.file), "utf8")
        writeFileSync(target, toRawMarkdown(options.rawMarkdown ? await options.rawMarkdown(source, page) : source, { siteUrl: `${config.site.url}${config.appBase.replace(/\/+$/, "")}`, pagePath: page.path }))
      }
    }
    nuxt.hook("build:before", writeRaw)
    // The link checker counts a link as built only when it was prerendered or sits in `public/`, and fetches any other
    // from the live site. The Markdown copies are neither, so it is told that every page has one.
    if (options.linkChecker !== false) {
      const linkChecker = (moduleOptions.linkChecker ??= {})
      linkChecker.excludeLinks = [...linkChecker.excludeLinks ?? [], ...docsManifestPages(manifest).map(page => docsAppPath(docsRawPath(page.path), config.appBase))]
    }

    // Nuxt UI prose headings read the heading anchor settings of @nuxtjs/mdc, which this site does not install.
    moduleOptions.runtimeConfig.public.mdc ??= { headings: { anchorLinks: { h1: false, h2: true, h3: true, h4: true, h5: false, h6: false } } }
    moduleOptions.appConfig.ui = docsAppConfigUi(vercelTheme(config.site.name), moduleOptions.appConfig.ui, moduleOptions._layers.map(layer => layer.config.appConfig?.ui))

    // The error page replaces `app.vue`, so the head that every page needs is part of the app's head config.
    const head = nuxt.options.app.head
    const meta = head.meta ??= []
    const viewport = meta.find(tag => tag.name === "viewport")
    // Content may use the area around a notch, and `100dvh` shrinks when the phone keyboard opens. A viewport that
    // the app set itself stays.
    if (!viewport?.content || viewport.content === "width=device-width, initial-scale=1") {
      if (viewport) meta.splice(meta.indexOf(viewport), 1)
      meta.push({ name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" })
    }
    meta.push({ name: "color-scheme", content: "light dark" })
    head.htmlAttrs = { lang: "en", dir: "ltr", ...head.htmlAttrs }
    // `app.vue` sets the full title template. The error page uses this one: "Page not found · ViteHub".
    head.titleTemplate ??= `%s · ${config.site.name}`

    moduleOptions.llms = defu(moduleOptions.llms, {
      domain: config.site.url ? `${config.site.url}${config.appBase.replace(/\/+$/, "")}` : "",
      title: config.site.name,
      description: config.site.description,
      full: { title: config.site.name, description: config.site.description },
    })
    const discovery: AgentDiscoveryOptions = {
      source: join(runtime, "server/agent-source.js"),
      siteName: config.site.name,
      siteUrl: config.site.url,
      discovery: {
        // At the site root nuxt-agent-discovery writes the robots.txt Sitemap line, but only for the exact link
        // `/sitemap.xml`. Mounted below a path, the app does not own the host's robots.txt, so the link is absolute.
        links: [{ href: config.appBase === "/" ? "/sitemap.xml" : `${config.site.url}${docsAppPath("/sitemap.xml", config.appBase)}`, rel: "sitemap", type: "application/xml", title: "Sitemap (XML)" }],
        mcpServerCard: config.mcp ? { endpoint: `${config.site.url}${docsAppPath("/mcp", config.appBase)}`, name: config.mcp.name } : false,
      },
    }
    const agentDiscoveryOptions: AgentDiscoveryOptions = defu(moduleOptions.agentDiscovery, discovery)
    // A page outside the manifest has no Markdown twin, so by default only the manifest pages negotiate.
    if (!agentDiscoveryOptions.routes?.length) {
      const standalone = manifest.pages.map(page => page.path).filter(path => path !== "/")
      agentDiscoveryOptions.routes = config.appBase === "/"
        ? [...new Set(["/", config.base, `${config.base.replace(/\/+$/, "")}/**`, ...standalone])]
        // Discovery currently accepts only an origin as siteUrl. Give it explicit public raw destinations for both
        // Nitro's app-relative request paths and the public paths returned by the content source.
        : docsManifestPages(manifest).flatMap(page => [...new Set([page.path, docsAppPath(page.path, config.appBase).replace(/(.)\/$/, "$1")])]
            .map(path => ({ path, raw: docsAppPath(docsRawPath(page.path), config.appBase) })))
    }
    moduleOptions.agentDiscovery = agentDiscoveryOptions

    if (config.mcp) {
      Reflect.apply(nuxt.hook, nuxt, ["mcp:definitions:paths", (paths: { tools: string[] }) => {
        paths.tools.push(join(runtime, "mcp"))
      }])
    }

    // The manifest is data, not code: the app and the server import the same file, so both see a content change.
    const manifestSource = () => `export default ${JSON.stringify(manifest)}\n`
    const manifestFile = addTemplate({ filename: "docs/manifest.mjs", getContents: manifestSource, write: true }).dst
    nuxt.options.alias["#docs/manifest"] = manifestFile
    addTemplate({ filename: "docs/manifest.d.mts", getContents: () => `import type { DocsManifest } from "@vite-hub/docs"\ndeclare const manifest: DocsManifest\nexport default manifest\n`, write: true })
    nuxt.options.alias["#docs/navigation"] = resolver.resolve("./navigation.js")
    // The page route reads drafts through the app's Content runtime, the module that ViteHub's Content routes import.
    // Without `server/content.ts` the route imports `undefined` and bundles nothing more.
    const contentEntry = await findContentEntry({ projectRoot: nuxt.options.rootDir, serverDirs: [nuxt.options.serverDir] })
    const contentFile = addTemplate({
      filename: "docs/content.mjs",
      write: true,
      getContents: () => contentEntry ? `export { content } from ${JSON.stringify(contentEntry)}\n` : "export const content = undefined\n",
    }).dst

    // The page route and search import the parser options. Without `parser` they parse with the built-in plugins only.
    const parserEntry = options.parser ? resolve(nuxt.options.rootDir, options.parser) : null
    const parserFile = addTemplate({
      filename: "docs/parser.mjs",
      write: true,
      getContents: () => parserEntry ? `export { default } from ${JSON.stringify(parserEntry)}\n` : "export default {}\n",
    }).dst

    // Nuxt watches the app folder, and the content folder usually sits beside it, so the module watches it in development.
    if (nuxt.options.dev) {
      // Watch the nearest existing parent until the configured content directory is created.
      let watchDir = contentDir
      while (!existsSync(watchDir) && dirname(watchDir) !== watchDir) watchDir = dirname(watchDir)
      let timer: ReturnType<typeof setTimeout> | undefined
      let regeneration = Promise.resolve()
      let closed = false
      const logError = (error: unknown) => useLogger("@vite-hub/docs").error(error)
      const watcher = watch(watchDir, { recursive: true }, (event, file) => {
        if (file) {
          const changedPath = resolve(watchDir, file)
          if (changedPath !== contentDir && !changedPath.startsWith(`${contentDir}${sep}`) && !contentDir.startsWith(`${changedPath}${sep}`)) return
          if (event === "change" && !/(\.md|\.navigation\.yml)$/.test(file)) return
        }
        clearTimeout(timer)
        timer = setTimeout(() => {
          // A transform may be asynchronous. Each run must finish before another can replace its raw output.
          regeneration = regeneration.then(async () => {
            if (closed) return
            try {
              const next = createDocsManifest({ dir: contentDir, base: config.base })
              const changed = JSON.stringify(next) !== JSON.stringify(manifest)
              await writeRaw(next)
              manifest = next
              // Do not await restart here: Nuxt closes the watcher and drains this run before restarting.
              if (changed && !closed) void Promise.resolve(nuxt.callHook("restart")).catch(logError)
            }
            catch (error) {
              // A half-typed frontmatter must not stop the server. The site keeps the last valid pages until the file is fixed.
              logError(error)
            }
          })
        }, 100)
      })
      nuxt.hook("close", async () => {
        closed = true
        clearTimeout(timer)
        watcher.close()
        await regeneration
      })
    }

    // Tailwind scans the app; the docs components and the Markdown pages live outside it.
    nuxt.options.css.unshift(addTemplate({
      filename: "docs/docs.css",
      write: true,
      getContents: () => [
        `@import "tailwindcss";`,
        `@import "@nuxt/ui";`,
        `@source "${join(runtime, "app")}";`,
        `@source "${resolver.resolve("./theme.js")}";`,
        `@source "${contentDir}";`,
        `@import "${join(runtime, "theme/vercel.css")}";`,
        "",
      ].join("\n"),
    }).dst)

    // @nuxt/icon bundles only the icons it finds in the app, so add the shell's icons and the configured ones.
    Reflect.apply(nuxt.hook, nuxt, ["icon:clientBundleIcons", (icons: Set<string>) => {
      const names = [
        ...shellIcons,
        config.icons.page,
        config.icons.section,
        ...[...config.start?.links ?? [], ...config.socials].map(link => link.icon),
        ...docsManifestPages(manifest).map(page => docsPageIcon(config.icons, page)),
        ...manifest.sections.flatMap(section => [docsSectionIcon(config.icons, section), docsRailIcon(config.icons, section)]),
      ]
      for (const name of names) {
        const icon = name && iconifyName(name)
        if (icon) icons.add(icon)
      }
    }])

    // App components with the same name replace these, so a site can restyle one piece without forking the shell.
    // Components in `components/content/` are the blocks that Markdown pages use, such as `::tutorial-step`. Nuxt scans
    // a folder once, so the content folders register before the folders that contain them.
    const contentDirs = [join(runtime, "app/components/content"), ...nuxt.options._layers.map(layer => join(layer.config.srcDir, "components/content")).filter(dir => existsSync(dir))]
    addComponentsDir({ path: contentDirs[0]!, pathPrefix: false, priority: -1 })
    addComponentsDir({ path: join(runtime, "app/components"), pathPrefix: false, priority: -1, ignore: ["content/**"] })
    nuxt.hook("components:dirs", (dirs) => {
      for (const path of contentDirs.slice(1)) dirs.unshift({ path, pathPrefix: false, prefix: "" })
    })
    let contentComponents: Array<{ kebabName: string, filePath: string }> = []
    nuxt.hook("components:extend", (components) => {
      contentComponents = components.filter(component => contentDirs.some(dir => component.filePath.startsWith(`${dir}/`)))
    })
    nuxt.options.alias["#docs/components"] = addTemplate({
      filename: "docs/components.mjs",
      write: true,
      getContents: () => `export default {\n${contentComponents.map(component => `  ${JSON.stringify(component.kebabName)}: () => import(${JSON.stringify(component.filePath)}),`).join("\n")}\n}\n`,
    }).dst
    addTemplate({ filename: "docs/components.d.mts", write: true, getContents: () => `import type { Component } from "vue"\ndeclare const components: Record<string, (() => Promise<{ default: Component }>) | undefined>\nexport default components\n` })
    addImportsDir([join(runtime, "app/composables"), join(runtime, "app/utils")])
    nuxt.hook("app:templates", (app) => {
      for (const name of ["default", "docs"]) {
        app.layouts[name] ??= { file: join(runtime, `app/layouts/${name}.vue`), name }
      }
    })
    addPlugin({ src: join(runtime, "app/plugins/theme-color.ts"), mode: "all" })
    addRouteMiddleware({ name: "docs-layout", path: join(runtime, "app/middleware/docs-layout.ts"), global: true })
    extendPages((pages) => {
      // A catch-all of the app, such as `pages/[...slug].vue`, can replace the docs page. One that leaves docs pages
      // out, such as `pages/blog/[...slug].vue`, does not, and the docs route registers beside it.
      if (coversDocsPages(pages, docsManifestPages(manifest).map(page => page.path))) return
      pages.push({ name: "docs-page", path: "/:slug(.*)*", file: join(runtime, "app/pages/docs-page.vue") })
    })
    nuxt.hook("app:resolve", (app) => {
      if (!app.mainComponent || app.mainComponent.includes("@nuxt/ui-templates") || app.mainComponent.includes("nuxt/dist/app/components/welcome")) app.mainComponent = join(runtime, "app/app.vue")
      if (!app.errorComponent || app.errorComponent.includes("nuxt/dist/app/components/nuxt-error-page")) app.errorComponent = join(runtime, "app/error.vue")
    })

    // Nitro mounts handlers, public assets, and prerender fetches below app.baseURL itself.
    addServerHandler({ route: "/api/_docs/page/**", handler: resolver.resolve("./runtime/server/page.js") })
    addServerHandler({ route: "/api/_docs/search.json", handler: resolver.resolve("./runtime/server/search.js") })
    addServerHandler({ route: "/sitemap.xml", handler: resolver.resolve("./runtime/server/sitemap.js") })
    // The raw copy is the file as written, without the frontmatter that nuxt-agent-discovery adds to its own raw route.
    // HEAD too: link checkers probe with it, and a GET-only route answers it with a 404.
    for (const method of ["get", "head"] as const) addServerHandler({ route: "/raw/**", method, handler: resolver.resolve("./runtime/server/raw.js") })

    /**
     * The routes that the build prerenders. Nuxt lets the client read `_payload.json` only when the Nitro config lists
     * prerender routes. Routes from the `prerender:routes` hook come too late: the prerendered HTML then has no page
     * data, and every static page hydrates to "Page not found".
     */
    function prerenderRoutes(): string[] {
      return [
        ...docsManifestPages(manifest).flatMap(page => [
          page.path,
          // Client navigation reads the parsed page, so static hosts serve it instead of parsing on each request.
          `/api/_docs/page${page.path === "/" ? "/index" : page.path}.json`,
        ]),
        "/api/_docs/search.json",
        "/sitemap.xml",
        // nuxt-agent-discovery serves the Markdown sitemap per request. Its pages are known at build time.
        "/sitemap.md",
      ]
    }

    // Nuxt types `nitro:config` only when Nitro's types load.
    Reflect.apply(nuxt.hook, nuxt, ["nitro:config", (nitro: NitroOptions) => {
      if (config.appBase !== "/") {
        // Discovery builds its default resource registry after all modules load. Its Link headers and public resource
        // links are browser URLs, unlike Nitro's route keys, so prefix the generated registry here too.
        for (const link of [...nitro.runtimeConfig?.agentDiscovery?.links ?? [], ...nitro.runtimeConfig?.public?.agentDiscovery?.resources ?? []]) {
          link.href = docsAppPath(link.href, config.appBase)
          if (link.anchor) link.anchor = docsAppPath(link.anchor, config.appBase)
        }
        for (const rule of Object.values(nitro.routeRules ?? {})) {
          for (const key of Object.keys(rule.headers ?? {})) {
            if (key.toLowerCase() === "link") rule.headers![key] = rule.headers![key]!.replace(/<(\/[^>]+)>/g, (_match, path: string) => `<${docsAppPath(path, config.appBase)}>`)
          }
        }
      }
      nitro.alias = { ...nitro.alias, "#docs/manifest": manifestFile, "#docs/content": contentFile, "#docs/parser": parserFile }
      // Nitro 2 development leaves absolute modules outside the app to Node. Bundle the generated modules, so the page
      // route reads the same Content runtime as ViteHub's Content routes instead of a second copy of `server/content.ts`.
      const inline = nitro.externals?.inline
      if (inline !== true) nitro.externals = { ...nitro.externals, inline: [...Array.isArray(inline) ? inline : [], dirname(manifestFile)] }
      // Pages are read at runtime, so a host without a file system serves them too.
      nitro.serverAssets = [...nitro.serverAssets ?? [], { baseName: "docs", dir: contentDir, pattern: "**/*.md" }, { baseName: "docs-raw", dir: rawDir }]
      // A removed page has no raw file. Fall through so a redirect route rule answers it.
      nitro.publicAssets = [...nitro.publicAssets ?? [], { baseURL: "/raw", dir: rawDir, fallthrough: true, maxAge: 300 }]
      // `docs/kv.html` beside the `docs/kv/` folder, and every linked page, as static hosts expect. Development
      // prerenders nothing, and Nuxt would turn listed routes into prerender route rules there.
      nitro.prerender = defu(nitro.prerender, { crawlLinks: true, autoSubfolderIndex: false, routes: nuxt.options.dev ? [] : prerenderRoutes() })
      // The MCP toolkit reads the current request through Nitro's async context.
      if (config.mcp) nitro.experimental = { ...nitro.experimental, asyncContext: true }
    }])
  },
})

/** Icons of the shell components and the theme. */
const shellIcons = [
  "i-lucide-arrow-right", "i-lucide-book-open", "i-lucide-check", "i-lucide-chevron-down", "i-lucide-copy", "i-lucide-file",
  "i-lucide-folder-open", "i-lucide-link", "i-lucide-panel-left", "i-lucide-plug", "i-lucide-search", "i-lucide-x",
  "i-ph-github-logo-light", "i-ph-moon-light", "i-ph-sun-light", "i-simple-icons-anthropic", "i-simple-icons-cursor",
  "i-simple-icons-github", "i-simple-icons-markdown", "i-simple-icons-openai", "i-simple-icons-visualstudiocode",
  "i-vscode-icons-file-type-js-official", "i-vscode-icons-file-type-text",
]

/**
 * `i-ph-sun-light` as @nuxt/icon bundles it: `ph:sun-light`. Collection names with one hyphen end in `-icons`, such as
 * `simple-icons`. Rail icon names such as `kv` are not Iconify names and return `null`.
 */
function iconifyName(icon: string): string | null {
  const match = /^i-([a-z0-9]+(?:-icons)?)-(.+)$/.exec(icon)
  return match ? `${match[1]}:${match[2]}` : icon.includes(":") ? icon : null
}

/** A module that this package depends on, by file path, so Nuxt finds it and transpiles its runtime. */
function dependency(name: string): string {
  return fileURLToPath(import.meta.resolve(name))
}

function publicConfig(options: DocsModuleOptions, appBase: string): DocsPublicConfig {
  const site = options.site ?? {}
  const url = (site.url ?? "").replace(/\/+$/, "")
  const dir = options.dir ?? "content"
  return {
    appBase: docsAppPath("/", appBase),
    base: normalizeDocsBase(options.base ?? "/docs"),
    site: {
      name: site.name ?? "Docs",
      url,
      description: site.description ?? "",
      logo: site.logo ? docsAppPath(site.logo, appBase) : null,
      badge: site.badge ? { label: site.badge.label, tooltip: site.badge.tooltip ?? null } : null,
    },
    categories: options.categories ?? [],
    railExclude: options.railExclude ?? [],
    start: options.start ? { section: options.start.section, links: options.start.links ?? [] } : undefined,
    socials: options.socials ?? [],
    banner: options.banner ?? null,
    sitemap: options.sitemap ?? [],
    github: options.github ? { branch: "main", dir, ...options.github, url: `https://github.com/${options.github.repo}` } : false,
    icons: { rail: {}, sections: {}, pages: {}, aliases: {}, family: "", page: "i-lucide-file-text", section: "i-lucide-folder", ...options.icons },
    mcp: options.mcp === false ? false : { name: options.mcp?.name ?? (site.name ?? "docs").toLowerCase(), url: `${url}${docsAppPath("/mcp", appBase)}`, guide: options.mcp?.guide ?? null },
    assistant: options.assistant ? { agent: options.assistant === true ? "docs" : options.assistant.agent ?? "docs" } : false,
    ogImage: options.ogImage === false ? false : { component: options.ogImage?.component ?? "DocsPage" },
  }
}

export default docsNuxtModule
