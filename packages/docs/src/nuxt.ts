import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
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
  addTypeTemplate,
  createResolver,
  defineNuxtModule,
  extendPages,
  updateTemplates,
  useLogger,
} from "@nuxt/kit"
import { findContentEntry } from "@vite-hub/source/vite"
import { vitehubTheme } from "@vite-hub/ui/theme"
import { defu } from "defu"
import { addRoute, createRouter, findAllRoutes, routeToRegExp } from "rou3"

import { setupDocsAssistant } from "./assistant-nuxt.ts"
import { docsCommentsDependencies, type DocsCommentsOptions } from "./comments-nuxt.ts"
import { readModuleOptions } from "./module-options.ts"
import { checkDocsLinks, type DocsLinkCheckOptions } from "./check-links.ts"
import { docsFilesModule } from "./files.ts"
import { docsAppManifestSource, readDocsContent, resolveDocsSources } from "./manifest.ts"
import { docsAppPath, docsIndexedPages, docsManifestPages, docsPageIcon, docsPageIndexed, docsRailIcon, docsRawPath, docsSectionIcon, isDocsPath, normalizeDocsBase, normalizeDocsPath, type DocsGroup, type DocsIcons, type DocsLink } from "./navigation.ts"
import { docsContentSource } from "./agent-copy.ts"
import { docsMount, replacesDocsPage } from "./page.ts"
import { DocsRedirectError, docsRedirectProblems, docsRedirects, type DocsRouteRule } from "./redirects.ts"
import { DocsSeoError, docsSeoProblems, docsSitemapPaths, readDocsSeoPage, type DocsSeoPage } from "./seo-audit.ts"
import { docsAppConfigUi, docsThemeAdditions, docsThemeScope, docsUi, type DocsThemeUi } from "./theme.ts"
import { docsThemeCss } from "./theme-css.ts"

import type { ContentLlmsSection } from "@vite-hub/content"
import type { Nuxt } from "nuxt/schema"

import type { DocsContentSnapshot, DocsSourceInput } from "./manifest.ts"
import type { DocsSectionFile } from "./schema.ts"
import type { DocsPage } from "./types.ts"

export { DocsAssistantSetupError } from "./assistant-nuxt.ts"
export { DocsCommentsSetupError } from "./comments-nuxt.ts"
export { DocsRedirectError } from "./redirects.ts"
export type { DocsThemeScope } from "./theme.ts"
export { DocsSeoError } from "./seo-audit.ts"
export type { DocsCommentsOptions } from "./comments-nuxt.ts"

export interface DocsSiteOptions {
  /** Name in titles, the rail, and llms.txt. */
  name?: string
  /** Canonical origin, such as `https://vitehub.dev`. Raw Markdown links, canonical links, and the sitemap use it. */
  url?: string
  description?: string
  /**
   * The mark beside the name. A path is a one-color SVG that the theme fills with the text color, so it follows light and
   * dark mode. `{ light, dark? }` shows images as they are, such as a colored logo, with `dark` in dark mode.
   */
  logo?: string | { light: string, dark?: string }
  /** A short label after the name, such as `beta`, with an optional tooltip on the site brand. */
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
  /** Folder of Markdown pages, relative to the app root. Defaults to `content`. A page's URL is its path in the folder. */
  dir?: string
  /**
   * Pages from folders and Content Sources, replacing `dir`: a folder relative to the app root, a Source such as
   * `github({ repo, root })` from `vite-hub/source`, or `{ source, mount?, exclude?, frontmatter? }`. The app-owned
   * docsAssistant Workspace is configured separately.
   */
  sources?: DocsSourceInput[]
  /** Section metadata overrides, keyed by section id. */
  sections?: Record<string, DocsSectionFile>
  /** Module exporting a default component map for Markdown tags. */
  components?: string
  /**
   * URL prefix whose folders are sections in the rail. Defaults to `/docs` when the content folder has a `docs/` folder,
   * and to `/` when it has none, so the docs are the whole site. Mapped sources default to `/docs`.
   */
  base?: string
  site?: DocsSiteOptions
  /** Order of section categories in the rail and the catalog. Sections of other categories come after them in the rail. */
  categories?: string[]
  /** Categories that the catalog lists but the rail leaves out, such as shared reference topics. */
  railExclude?: string[]
  /**
   * Rail items that hold several sections. The rail shows one item per group, and the sidebar of a member section
   * lists every section of the group. A section joins a group here or with `group` in its `.navigation.yml`.
   */
  groups?: DocsGroup[]
  start?: DocsStartOptions
  /** Community links in the header on every page, such as a chat server. GitHub comes from `github`. */
  socials?: DocsLink[]
  /** Site pages linked at the end of every docs page, such as About and Privacy, so each one has a link to it. */
  footer?: DocsLink[]
  /** One line above every docs page, such as a release status. */
  banner?: string
  /** More paths for `/sitemap.xml`, such as app pages outside the content folder. Every docs page is listed already. */
  sitemap?: string[]
  /** The repository of the site. `dir` is the content folder inside the repository. */
  github?: { repo: string, branch?: string, dir?: string } | false
  /** Icon maps of the rail and the sidebar. */
  icons?: Partial<DocsIcons>
  /**
   * The docs MCP server at `/mcp`, with the `list-pages` and `get-page` tools of Content. `name` is the server name that
   * page actions suggest, and `guide` is the page that explains how to connect it. `false` turns it off.
   */
  mcp?: { name?: string, guide?: string } | false
  /**
   * More text for `/llms.txt`. `details` goes under the site description, such as rules for agents. `sections` adds
   * sections of links, `[{ title, description?, links: [{ title, href, description? }] }]`, before the sections of pages.
   */
  llms?: DocsLlmsOptions
  /**
   * Checks links on prerendered pages with `nuxt-link-checker` and fails the build on detected errors.
   * Also checks cross-page fragments against the final HTML output.
   * Remote URLs are not fetched. Routes excluded by Nitro's prerender policy may be served at request time. A link to
   * an exact `redirect` route rule passes, and the build checks instead that the rule leads to a docs page and hides
   * none. Exclusion lists accept public paths, globs, or regular expressions. `false` turns the check off.
   */
  linkChecker?: false | Pick<DocsLinkCheckOptions, "excludeLinks" | "excludePages" | "ignoreFragments" | "redirect">
  /**
   * Checks every prerendered page as a site audit does: a sitemap URL that is not a prerendered page, a missing or
   * duplicate title or description, a title outside 10 to 60 characters or a description outside 70 to 160, not exactly
   * one `h1`, a skipped heading level, fewer than 150 words, or a page that no other page links to. Pages with `noindex`
   * or a canonical link to another page are left out. `"warn"`, the default, logs the problems. `"error"` or `true` stops the
   * build with `DocsSeoError`. `false` turns the check off.
   */
  seoAudit?: "warn" | "error" | boolean
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
   * a component into plain Markdown. The built-in rewrites run after it. Runs at build time, and the server keeps the
   * pages that it changed.
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
   * Path of a module, relative to the app root, whose default export is the parser options: `{ comarkUi, examples,
   * plugins }`. Comark plugins and `examples.play` are functions, so they reach the server through a file and not
   * through this config. The page route, search, and Console drafts parse with it.
   */
  parser?: string
  /**
   * The folder, relative to the app's source folder, of the Vue files that `::example{name}` shows. Defaults to
   * `examples`, so `::example{name="ButtonExample"}` renders `app/examples/ButtonExample.vue` beside its source.
   */
  examples?: string
}

/** `llms` of the docs module options. */
export interface DocsLlmsOptions {
  details?: string
  sections?: ContentLlmsSection[]
}

/** The site mark: `mask` fills `src` with the text color, else `src` shows as it is, and `dark` in dark mode. */
export interface DocsLogo {
  src: string
  dark: string | null
  mask: boolean
}

/** Options as the client and the server read them from `runtimeConfig.public.docs`. */
export interface DocsPublicConfig {
  appBase: string
  base: string
  site: { name: string, url: string, description: string, logo: DocsLogo | null, badge: { label: string, tooltip: string | null } | null }
  categories: string[]
  railExclude: string[]
  groups: DocsGroup[]
  /** Absent without a `start` option. Nuxt turns a `null` in runtime config into an empty string. */
  start?: { section: string, links: DocsLink[] }
  socials: DocsLink[]
  footer: DocsLink[]
  banner: string | null
  sitemap: string[]
  /** `stars` is the repository's star count when the build could read it, else `null`. */
  github: { repo: string, branch: string, dir: string, url: string, stars: number | null } | false
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

interface PrerenderRoute {
  route: string
  contents?: string
  contentType?: string
  fileName?: string
  error?: Error
}

interface NitroInstance {
  options: NitroOptions & { output?: { publicDir: string } }
  hooks?: {
    hook(name: "compiled" | "prerender:done", handler: () => void): void
    hook(name: "prerender:generate", handler: (route: PrerenderRoute) => void): void
  }
}

interface NitroOptions {
  runtimeConfig?: DiscoveryRuntime
  routeRules?: Record<string, DocsRouteRule & { headers?: Record<string, string>, prerender?: boolean }>
  alias?: Record<string, string>
  serverAssets?: Array<{ baseName: string, dir: string, pattern?: string }>
  handlers?: Array<{ route: string, method?: string, handler: string }>
  virtual?: Record<string, string | (() => string | Promise<string>)>
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean, maxAge?: number }>
  prerender?: { crawlLinks?: boolean, autoSubfolderIndex?: boolean, routes?: string[], ignore?: Array<string | RegExp | ((path: string) => boolean | null | undefined)> }
}

interface AgentDiscoveryOptions {
  errors?: boolean
  siteUrl?: string
  source?: string | false
  siteName?: string
  routes?: Array<string | { path: string, raw?: string }>
  discovery?: { links?: Array<{ href: string, rel: string, type?: string, title?: string, anchor?: string, header?: boolean }>, mcpServerCard?: false | { endpoint: string, name?: string } }
}

/** Options of the modules that the docs module installs. Their own option types load only with their runtime. */
interface DocsNuxtOptions {
  rootDir: string
  appConfig: { ui?: DocsThemeUi }
  _layers: ReadonlyArray<{ config: { appConfig?: { ui?: DocsThemeUi } } }>
  runtimeConfig: { public: { mdc?: unknown } }
  agentDiscovery?: AgentDiscoveryOptions
  linkChecker?: { excludeLinks?: Array<string | RegExp> }
  fonts?: { families?: Array<{ name: string, global?: boolean }> }
}

export interface DocsNuxtModule {
  (inlineOptions: DocsModuleOptions, nuxt: never): unknown
  getMeta?: () => Promise<Record<string, unknown>>
}

const docsNuxtModule: DocsNuxtModule = defineNuxtModule<DocsModuleOptions>({
  meta: { configKey: "docs", name: "@vite-hub/docs" },
  defaults: {},
  // Nuxt installs these after this module, so the options that the setup writes reach them. Most resolve from this
  // package, so the app does not list them.
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
      [dependency("nuxt-agent-discovery")]: {},
      // Site name, URL, and description for every Nuxt SEO module: the link checker, share images, and Schema.org.
      [dependency("nuxt-site-config")]: { defaults: { name: docs.site?.name ?? "Docs", url: docs.site?.url, description: docs.site?.description, defaultLocale: "en" } },
      // Images render while the build prerenders, so the server bundle carries no renderer and a Worker stays small.
      // Disabled setup still registers the no-op composable imported by useDocsSeo.
      // No runtime cache: its default `lru-cache` storage makes Nitro install `lru-cache` into the app on the first `nuxt dev`.
      [dependency("nuxt-og-image")]: { defaults: { enabled: docs.ogImage !== false, zeroRuntime: true, runtimeCacheStorage: false, defaults: { width: 1200, height: 630 } } },
      [dependency("nuxt-schema-org")]: {},
      // Installed after the app's modules and just before the link checker, so links to their redirect rules pass.
      ...docs.linkChecker === false ? {} : {
        [fileURLToPath(new URL("./link-checker-redirects.js", import.meta.url))]: {},
        [dependency("nuxt-link-checker")]: { defaults: { failOnError: true, fetchRemoteUrls: false, showLiveInspections: false } },
      },
    }
  },
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const runtime = resolver.resolve("./runtime")
    // Nuxt transpiles the package of the module path it loaded. Through `vite-hub/docs/nuxt` that is `vite-hub`, so this
    // package must be listed itself: its Vue app runtime ships as `.vue` and `.ts` source that imports `#imports`.
    const packageRoot = resolver.resolve("..")
    nuxt.options.build.transpile.push(packageRoot)
    // The shell renders with Comark, comark-ui and its block packages, and VueUse. They go into the app's server bundle
    // so that they share its copy of Vue. Nitro would bundle them with a second copy that has no app, and Markdown would
    // render on the server without the app's prose components.
    nuxt.options.build.transpile.push(/^(?:@comark\/|comark(?:-[\w-]+)?(?:\/|$))/, "@vueuse/core")
    // Nuxt auto-imports composables only outside node_modules. The shell components use them, so an app that installs
    // this package needs its files included, or they fail with `useRoute is not defined`.
    const transform = nuxt.options.imports.transform ??= {}
    transform.include ??= []
    transform.include.push(new RegExp(`^${packageRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`))
    const contentDir = resolve(nuxt.options.rootDir, options.dir ?? "content")
    const sources = options.sources && resolveDocsSources(options.sources, nuxt.options.rootDir)
    // The server cannot read a Content Source, such as `github()`, so the build copies its pages here.
    const sourcesDir = join(nuxt.options.buildDir, "docs/sources")
    /** The folder that the server reads each source's pages from, by page `source` name. */
    const sourceDirs = sources?.map((source, index) => source.dir ?? join(sourcesDir, `docs-${index}`))
    const contentDirsToWatch = sources ? sources.flatMap(source => source.dir ?? []) : [contentDir]
    const agentDir = join(nuxt.options.buildDir, "docs/agent")
    const base = normalizeDocsBase(options.base ?? (sources || existsSync(join(contentDir, "docs")) ? "/docs" : "/"))
    const manifestOptions = { dir: contentDir, base, sources: options.sources, rootDir: nuxt.options.rootDir, sections: options.sections }
    const config = publicConfig(options, base, nuxt.options.app.baseURL)
    // Without an `app.vue` of its own, the app is the docs site: the docs `app.vue` draws the site header, search, and
    // head on every page. An app with its own `app.vue` keeps it, and the docs layouts draw them on docs pages only.
    const ownsApp = !hasAppComponent(nuxt.options._layers.map(layer => layer.config.srcDir), nuxt.options.extensions)
    nuxt.options.alias["#docs/shell"] = addTemplate({ filename: "docs/shell.mjs", write: true, getContents: () => `export const ownsApp = ${ownsApp}\n` }).dst
    addTemplate({ filename: "docs/shell.d.mts", write: true, getContents: () => "export declare const ownsApp: boolean\n" })
    // comark-ui's blocks add their styles when they mount. The page links them too, so the first paint, before the app
    // hydrates, shows no raw blocks, such as an anchor's screen reader text or a tab row as plain text. They are one
    // static file, because Vite's CSS pipeline does not parse some of their newer syntax, such as `interpolate-size`.
    const stylesDir = join(nuxt.options.buildDir, "docs/styles")
    const comarkCss = comarkStylesheet()
    const comarkCssFile = `comark-${createHash("sha256").update(comarkCss).digest("hex").slice(0, 10)}.css`
    function writeComarkCss() {
      mkdirSync(stylesDir, { recursive: true })
      writeFileSync(join(stylesDir, comarkCssFile), comarkCss)
    }
    writeComarkCss()
    // A production build empties the build directory before it starts, so the file is written again after that.
    nuxt.hook("build:before", writeComarkCss)
    if (config.github && !nuxt.options.dev) config.github.stars = await githubStars(config.github.repo)
    nuxt.options.runtimeConfig.public.docs = config
    // Nuxt types runtime config from its value, and that type has no fields for objects in arrays, such as `socials`.
    addTypeTemplate({ filename: "types/vite-hub-docs.d.ts", getContents: () => docsRuntimeConfigTypes })
    setupDocsAssistant(nuxt, config)
    // The panel calls `useChat()` from `vite-hub/nuxt`, so without the assistant `DocsAssistant` renders nothing.
    addComponent({ name: "DocsAssistant", filePath: join(runtime, config.assistant ? "app/assistant/DocsAssistant.vue" : "app/assistant/DocsAssistantOff.vue") })
    if (config.assistant) addComponent({ name: "DocsAssistantPanel", filePath: join(runtime, "app/assistant/DocsAssistantPanel.vue") })
    const moduleOptions: DocsNuxtOptions = nuxt.options

    let read = await readDocsContent(manifestOptions)
    let manifest = read.manifest
    /** Copies the pages of each Content Source into the build, where the server and the agent copies read them. */
    function writeSources(files: DocsContentSnapshot["files"]) {
      rmSync(sourcesDir, { force: true, recursive: true })
      for (const file of files) {
        const target = join(sourcesDir, file.source, file.file)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.markdown)
      }
    }
    writeSources(read.files)
    /**
     * Content renders the agent copy of each page on request. `rawMarkdown` is a function of the app's build, so it runs
     * here, and the server reads each page that it changed from `docs/agent/<source>/<file>`. `nuxi build` empties the
     * build folder after the modules load, so it runs before the build.
     */
    async function writeAgentSources(snapshot = read) {
      writeSources(snapshot.files)
      rmSync(agentDir, { force: true, recursive: true })
      mkdirSync(agentDir, { recursive: true })
      const rawMarkdown = options.rawMarkdown
      if (!rawMarkdown) return
      for (const page of docsManifestPages(snapshot.manifest)) {
        const source = readFileSync(join(page.source ? sourceDirs![Number(page.source.slice(5))]! : contentDir, page.file), "utf8")
        const rewritten = await rawMarkdown(source, page)
        if (rewritten === source) continue
        const target = join(agentDir, docsContentSource(page), page.file)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, rewritten)
      }
    }
    nuxt.hook("build:before", writeAgentSources)
    // The link checker counts a link as built only when it was prerendered or sits in `public/`, and fetches any other
    // from the live site. The Markdown copies are neither, so it is told that every page has one.
    if (options.linkChecker !== false) {
      const linkChecker = (moduleOptions.linkChecker ??= {})
      linkChecker.excludeLinks = [
        ...linkChecker.excludeLinks ?? [],
        ...options.linkChecker?.excludeLinks ?? [],
        ...docsManifestPages(manifest).map(page => docsAppPath(docsRawPath(page.path), config.appBase)),
        // A page with `seo.index: false` is not prerendered, but the manifest has it, so links to it are valid.
        ...docsManifestPages(manifest).filter(page => !docsPageIndexed(page)).map(page => docsAppPath(page.path, config.appBase)),
      ]
    }

    // Nuxt UI prose headings read the heading anchor settings of @nuxtjs/mdc, which this site does not install.
    moduleOptions.runtimeConfig.public.mdc ??= { headings: { anchorLinks: { h1: false, h2: true, h3: true, h4: true, h5: false, h6: false } } }
    // A docs site gets the design in its app config. An app with its own `app.vue` keeps its app config, and the docs
    // layouts wrap the docs pages in `<UTheme>` with the design instead.
    const design = docsUi(config.site.name)
    moduleOptions.appConfig.ui = docsAppConfigUi(ownsApp ? design : docsThemeAdditions(design), moduleOptions.appConfig.ui, moduleOptions._layers.map(layer => layer.config.appConfig?.ui))
    nuxt.options.alias["#docs/theme"] = addTemplate({ filename: "docs/theme.mjs", write: true, getContents: () => `export default ${JSON.stringify(ownsApp ? { ui: {}, props: {} } : docsThemeScope(design))}\n` }).dst
    addTemplate({ filename: "docs/theme.d.mts", write: true, getContents: () => `import type { DocsThemeScope } from "@vite-hub/docs/nuxt"\ndeclare const theme: DocsThemeScope\nexport default theme\n` })

    // The design system lists "Geist Variable" first, the font that the Console bundles. @nuxt/fonts, which Nuxt UI
    // installs, serves only the first family of a declaration, so it served no Geist. The docs ask for both families.
    const fonts = moduleOptions.fonts ??= {}
    const families = fonts.families ??= []
    for (const name of ["Geist", "Geist Mono"]) {
      if (!families.some(family => family.name === name)) families.push({ name, global: true })
    }

    // The error page replaces `app.vue`, so the head that every page needs is part of the app's head config. In an app
    // with its own `app.vue`, the head stays the app's, and the docs layouts set the docs head on docs pages.
    if (ownsApp) setDocsHead(nuxt.options.app.head, config.site.name)

    const discovery: AgentDiscoveryOptions = {
      // Content serves the copies at `/raw/<page>.md`. nuxt-agent-discovery negotiates `.md` twins and
      // `Accept: text/markdown` to them, and answers Markdown 404s.
      source: false,
      siteName: config.site.name,
      siteUrl: config.site.url,
      discovery: {
        links: [
          { href: "/sitemap.md", rel: "sitemap", type: "text/markdown", title: "Sitemap (Markdown): every page on the site" },
          { href: "/llms.txt", rel: "describedby", type: "text/plain", title: "llms.txt: index of the documentation for LLMs" },
          { href: "/llms.txt", rel: "service-desc", type: "text/plain", anchor: "/", header: false },
          { href: "/llms-full.txt", rel: "describedby", type: "text/plain", title: "llms-full.txt: the full documentation as a single file" },
          { href: "/llms-full.txt", rel: "service-desc", type: "text/plain", anchor: "/", header: false },
          // At the site root nuxt-agent-discovery writes the robots.txt Sitemap line, but only for the exact link
          // `/sitemap.xml`. Mounted below a path, the app does not own the host's robots.txt, so the link is absolute.
          { href: config.appBase === "/" ? "/sitemap.xml" : `${config.site.url}${docsAppPath("/sitemap.xml", config.appBase)}`, rel: "sitemap", type: "application/xml", title: "Sitemap (XML)" },
        ],
        mcpServerCard: config.mcp ? { endpoint: `${config.site.url}${docsAppPath("/mcp", config.appBase)}`, name: config.mcp.name } : false,
      },
    }
    const agentDiscoveryOptions: AgentDiscoveryOptions = defu(moduleOptions.agentDiscovery, discovery)
    // Nuxt's inline HTML errors bypass Agent Discovery's Nitro Markdown error handler.
    if (agentDiscoveryOptions.errors !== false) nuxt.options.experimental.inlineErrorRendering = false
    // A page outside the manifest has no Markdown twin, so by default only the manifest pages negotiate.
    if (!agentDiscoveryOptions.routes?.length) {
      const standalone = manifest.pages.map(page => page.path).filter(path => path !== "/")
      agentDiscoveryOptions.routes = config.appBase === "/"
        // `/` only when it is a docs page: an app's own home page has no Markdown twin.
        ? [...new Set([...manifest.root?.path === "/" || manifest.pages.some(page => page.path === "/") ? ["/"] : [], config.base, `${config.base.replace(/\/+$/, "")}/**`, ...standalone])]
        // Discovery currently accepts only an origin as siteUrl. Give it explicit public raw destinations for both
        // Nitro's app-relative request paths and the public paths returned by the content source.
        : docsManifestPages(manifest).flatMap(page => [...new Set([page.path, docsAppPath(page.path, config.appBase).replace(/(.)\/$/, "$1")])]
            .map(path => ({ path, raw: docsAppPath(docsRawPath(page.path), config.appBase) })))
    }
    moduleOptions.agentDiscovery = agentDiscoveryOptions

    // The `llms` option for Content's `llms.txt`. Server code only, so it stays out of the page payload.
    const agentFile = addTemplate({
      filename: "docs/agent.mjs",
      write: true,
      getContents: () => `export default ${JSON.stringify({ llms: { ...options.llms?.details ? { details: options.llms.details } : {}, ...options.llms?.sections ? { sections: options.llms.sections } : {} } })}\n`,
    }).dst

    // The manifest is data, not code: the server imports the whole manifest, and the app a copy with only the page
    // fields that it reads. Both are written from the same manifest, so both see a content change.
    // `JSON.parse` of a string parses much faster than an object literal of the same size, and every page loads it.
    const manifestSource = () => `export default JSON.parse(${JSON.stringify(JSON.stringify(manifest))})\n`
    const manifestFile = addTemplate({ filename: "docs/manifest.mjs", getContents: manifestSource, write: true }).dst
    // Types `#docs/manifest` in server code. Nitro 2 maps the alias to `docs/manifest` without an extension, so the
    // declaration is `.d.ts`, not `.d.mts`. Nuxt finds a `.d.ts` beside the module too.
    addTemplate({ filename: "docs/manifest.d.ts", getContents: () => `import type { DocsManifest } from "@vite-hub/docs"\ndeclare const manifest: DocsManifest\nexport default manifest\n`, write: true })
    nuxt.options.alias["#docs/manifest"] = addTemplate({ filename: "docs/app-manifest.mjs", getContents: () => docsAppManifestSource(manifest), write: true }).dst
    addTemplate({ filename: "docs/app-manifest.d.mts", getContents: () => `import type { DocsAppPage, DocsManifest } from "@vite-hub/docs"\ndeclare const manifest: DocsManifest<DocsAppPage>\nexport default manifest\n`, write: true })
    nuxt.options.alias["#docs/navigation"] = resolver.resolve("./navigation.js")
    nuxt.options.alias["#docs/primitive-rail"] = resolver.resolve("./primitive-rail.js")
    nuxt.options.alias["#docs/comark-css"] = addTemplate({ filename: "docs/comark-css.mjs", write: true, getContents: () => `export default ${JSON.stringify(comarkCssFile)}\n` }).dst
    addTemplate({ filename: "docs/comark-css.d.mts", write: true, getContents: () => "declare const file: string\nexport default file\n" })
    // The page route reads drafts through the app's Content runtime, the module that ViteHub's Content routes import.
    // Without `server/content.ts` the route imports `undefined` and bundles nothing more.
    const contentEntry = await findContentEntry({ projectRoot: nuxt.options.rootDir, serverDirs: [nuxt.options.serverDir] })
    const contentFile = addTemplate({
      filename: "docs/content.mjs",
      write: true,
      getContents: () => contentEntry ? `export { default as content } from ${JSON.stringify(contentEntry)}\n` : "export const content = undefined\n",
    }).dst

    // The page route and search import the parser options. Without `parser` they parse with the built-in plugins only.
    // `githubRepo` is the site's repository, where `#123` in a page links.
    const parserEntry = options.parser ? resolve(nuxt.options.rootDir, options.parser) : null
    const parserFile = addTemplate({
      filename: "docs/parser.mjs",
      write: true,
      getContents: () => `${parserEntry ? `export { default } from ${JSON.stringify(parserEntry)}` : "export default {}"}\nexport const githubRepo = ${JSON.stringify(options.github ? options.github.repo : null)}\n`,
    }).dst

    const componentsEntry = options.components ? resolve(nuxt.options.rootDir, options.components) : null
    nuxt.options.alias["#docs/custom-components"] = addTemplate({ filename: "docs/custom-components.mjs", write: true, getContents: () => componentsEntry ? `export { default } from ${JSON.stringify(componentsEntry)}\n` : "export default {}\n" }).dst
    addTemplate({ filename: "docs/custom-components.d.mts", write: true, getContents: () => `import type { Component } from "vue"\ndeclare const components: Record<string, Component>\nexport default components\n` })
    // An app page in the docs layout picks its sidebar in `definePageMeta`, like the `sidebar` frontmatter of a docs page.
    addTypeTemplate({
      filename: "types/docs-page-meta.d.ts",
      getContents: () => `declare module "#app" {\n  interface PageMeta {\n    /** \`false\` hides the docs sidebar. \`"collapsed"\` shows a narrow strip with a button that opens it. */\n    sidebar?: boolean | "collapsed"\n  }\n}\nexport {}\n`,
    })

    // `::example{name}` shows a Vue file of the examples folder. The page loads the component, and the parser reads
    // its source, so the server bundle carries every source as a string.
    const examplesDir = resolve(nuxt.options.srcDir, options.examples ?? "examples")
    const exampleFiles = () => existsSync(examplesDir) ? readdirSync(examplesDir).filter(file => file.endsWith(".vue")).sort() : []
    nuxt.options.alias["#docs/examples"] = addTemplate({
      filename: "docs/examples.mjs",
      write: true,
      getContents: () => `export default {\n${exampleFiles().map(file => `  ${JSON.stringify(file.slice(0, -4))}: () => import(${JSON.stringify(join(examplesDir, file))}),`).join("\n")}\n}\n`,
    }).dst
    addTemplate({ filename: "docs/examples.d.mts", write: true, getContents: () => `import type { Component } from "vue"\ndeclare const examples: Record<string, (() => Promise<{ default: Component }>) | undefined>\nexport default examples\n` })
    const exampleSourcesFile = addTemplate({
      filename: "docs/example-sources.mjs",
      write: true,
      getContents: () => `export default ${JSON.stringify(Object.fromEntries(exampleFiles().map(file => [file.slice(0, -4), readFileSync(join(examplesDir, file), "utf8")])))}\n`,
    }).dst
    nuxt.hook("builder:watch", async (_event, path) => {
      if (resolve(nuxt.options.srcDir, path).startsWith(`${examplesDir}${sep}`)) await updateTemplates({ filter: template => template.filename.startsWith("docs/example") })
    })

    // Nuxt watches the app folder, and the content folder usually sits beside it, so the module watches it in development.
    if (nuxt.options.dev) {
      nuxt.options.watch = [...new Set([...(nuxt.options.watch ?? []), examplesDir])]
      let timer: ReturnType<typeof setTimeout> | undefined
      let regeneration = Promise.resolve()
      let closed = false
      const logError = (error: unknown) => useLogger("@vite-hub/docs").error(error)
      const watchers = contentDirsToWatch.map(contentDir => {
        let watchDir = contentDir
        while (!existsSync(watchDir) && dirname(watchDir) !== watchDir) watchDir = dirname(watchDir)
        return watch(watchDir, { recursive: true }, (event, file) => {
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
                const next = await readDocsContent(manifestOptions)
                const changed = JSON.stringify(next.manifest) !== JSON.stringify(manifest)
                await writeAgentSources(next)
                read = next
                manifest = next.manifest
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
      })
      nuxt.hook("close", async () => {
        closed = true
        clearTimeout(timer)
        for (const watcher of watchers) watcher.close()
        await regeneration
      })
    }

    // Tailwind scans the app; the docs components and the Markdown pages live outside it. Nuxt UI's `#build/ui.css`
    // lists the folders that Tailwind scans, so the docs folders go there. An app with its own `@import "@nuxt/ui"`
    // then builds the docs classes in its one Tailwind build. A second build would put its utilities after the docs
    // ones, so `flex` would win over `xl:hidden`. An app without one gets the Tailwind build of the docs.
    // Tailwind reads the design's classes from this file. In the package build, `theme.js` only re-exports a hashed chunk.
    const designClasses = addTemplate({ filename: "docs/design.json", write: true, getContents: () => JSON.stringify(design, null, 1) }).dst
    const cssSources = [join(runtime, "app"), designClasses, ...sourceDirs ?? [contentDir]].map(source => `@source "${source}";`).join("\n")
    nuxt.hook("app:templates", (app) => {
      const ui = app.templates.find(template => template.filename === "ui.css")
      const getContents = ui?.getContents
      if (ui && getContents) ui.getContents = async (data) => `${await getContents(data)}\n${cssSources}\n`
    })
    const sharedTheme = dependency("@vite-hub/ui/theme.css")
    const scopedTheme = ownsApp ? null : addTemplate({
      filename: "docs/theme.css",
      write: true,
      getContents: () => docsThemeCss(sharedTheme),
    })
    const docsCss = addTemplate({
      filename: "docs/docs.css",
      write: true,
      getContents: (): string => [
        // comark-ui's blocks style themselves in a `comark` layer. Naming the order first keeps Tailwind's base below it.
        `@layer theme, base, comark, components, utilities;`,
        // Absolute paths, like the theme below: the app may not depend on either package, and Nuxt can read this
        // template from outside the app (a custom `buildDir`), where a bare name does not resolve.
        ...importsNuxtUi(nuxt.options.css, nuxt.options.alias, docsCss.dst) ? [] : [`@import "${stylesheet("tailwindcss")}";`, `@import "${stylesheet("@nuxt/ui")}";`],
        `@import "${scopedTheme?.dst ?? sharedTheme}";`,
        `@import "${join(runtime, "theme/design.css")}";`,
        "",
      ].join("\n"),
    })
    nuxt.options.css.unshift(docsCss.dst)

    // @nuxt/icon bundles only the icons it finds in the app, so add the shell's icons and the configured ones.
    Reflect.apply(nuxt.hook, nuxt, ["icon:clientBundleIcons", (icons: Set<string>) => {
      const names = [
        ...shellIcons,
        ...Object.values(vitehubTheme.icons),
        config.icons.page,
        config.icons.section,
        ...[...config.start?.links ?? [], ...config.socials].map(link => link.icon),
        ...docsManifestPages(manifest).map(page => docsPageIcon(config.icons, page)),
        ...manifest.sections.flatMap(section => [docsSectionIcon(config.icons, section), docsRailIcon(config.icons, section)]),
        ...config.groups.map(group => group.icon),
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
      app.layouts.docs ??= { file: join(runtime, "app/layouts/docs.vue"), name: "docs" }
      // Pages outside the sections are plain articles. In the docs site they use the `default` layout, which an app
      // page uses too. In an app with its own `app.vue`, they get a layout of their own, so app pages keep theirs.
      const article = ownsApp ? "default" : "docs-article"
      app.layouts[article] ??= { file: join(runtime, "app/layouts/default.vue"), name: article }
    })
    // A prerendered page has a payload, and the sidebar links every page, so Nuxt's default of prefetching each link in
    // view downloaded every payload in the sidebar on the first visit, megabytes on a large site. A link prefetches when
    // the reader points at it or focuses it instead, unless the app chose when links prefetch.
    if (!nuxt.options._layers.some(layer => layer.config.experimental?.defaults?.nuxtLink?.prefetchOn))
      nuxt.options.experimental.defaults.nuxtLink.prefetchOn = { visibility: false, interaction: true }
    addPlugin({ src: join(runtime, "app/plugins/theme-color.ts"), mode: "all" })
    addPlugin({ src: join(runtime, "app/plugins/comark-css.ts"), mode: "all" })
    addPlugin({ src: join(runtime, "app/plugins/icon-stroke.ts"), mode: "all" })
    addRouteMiddleware({ name: "docs-layout", path: join(runtime, "app/middleware/docs-layout.ts"), global: true })
    extendPages((pages) => {
      // The docs page answers below the docs mount only, such as `/docs/:slug(.*)*`. An app catch-all page at the same
      // prefix replaces it. Vue Router prefers the longer static prefix, so a root catch-all of the app does not hide it.
      const mount = docsMount(manifest)
      if (replacesDocsPage(pages, mount)) return
      pages.push({ name: "docs-page", path: `${mount === "/" ? "" : mount}/:slug(.*)*`, file: join(runtime, "app/pages/docs-page.vue") })
    })
    // The docs site replaces Nuxt's own defaults: the welcome page, the `app.vue` of the pages module, and the error
    // page. An app with its own `app.vue` keeps its error page. Compare paths, as Nuxt does: the package is
    // `nuxt-nightly` on Nuxt 5 nightlies.
    const nuxtApp = [resolve(nuxt.options.appDir, "components/welcome.vue"), resolve(nuxt.options.appDir, "../pages/runtime/app.vue")]
    const nuxtErrorPage = resolve(nuxt.options.appDir, "components/nuxt-error-page.vue")
    nuxt.hook("app:resolve", (app) => {
      if (ownsApp && (!app.mainComponent || nuxtApp.includes(app.mainComponent) || app.mainComponent.includes("@nuxt/ui-templates"))) app.mainComponent = join(runtime, "app/app.vue")
      if (ownsApp && (!app.errorComponent || app.errorComponent === nuxtErrorPage)) app.errorComponent = join(runtime, "app/error.vue")
      if (!ownsApp && app.mainComponent) warnAppComponent(app.mainComponent)
    })
    // The shell moves between `app.vue` and the docs layouts when the app adds or removes its `app.vue`.
    nuxt.hook("builder:watch", (event, path) => {
      if ((event === "add" || event === "unlink") && /(^|\/)app\.\w+$/i.test(path) && hasAppComponent(nuxt.options._layers.map(layer => layer.config.srcDir), nuxt.options.extensions) === ownsApp) {
        void Promise.resolve(nuxt.callHook("restart")).catch(error => useLogger("@vite-hub/docs").error(error))
      }
    })

    // Nitro mounts handlers, public assets, and prerender fetches below app.baseURL itself.
    addServerHandler({ route: "/api/_docs/page/**", handler: resolver.resolve("./runtime/server/page.js") })
    addServerHandler({ route: "/api/_docs/search.json", handler: resolver.resolve("./runtime/server/search.js") })
    addServerHandler({ route: "/sitemap.xml", handler: resolver.resolve("./runtime/server/sitemap.js") })
    // Content serves the agent files. HEAD too: link checkers probe with it, and a GET-only route answers it with a 404.
    for (const method of ["get", "head"] as const) {
      for (const route of ["/llms.txt", "/llms-full.txt", "/sitemap.md"]) addServerHandler({ route, method, handler: resolver.resolve("./runtime/server/llms.js") })
    }
    if (config.mcp) addServerHandler({ route: "/mcp", handler: resolver.resolve("./runtime/server/mcp.js") })

    /**
     * The routes that the build prerenders. Nuxt lets the client read `_payload.json` only when the Nitro config lists
     * prerender routes. Routes from the `prerender:routes` hook come too late: the prerendered HTML then has no page
     * data, and every static page hydrates to "Page not found".
     */
    function prerenderRoutes(): string[] {
      return [
        ...docsIndexedPages(manifest).flatMap(page => [
          page.path,
          // Client navigation reads the parsed page, so static hosts serve it instead of parsing on each request.
          `/api/_docs/page${page.path === "/" ? "/index" : page.path}.json`,
        ]),
        // The agent copy of every page, also of the pages that search engines skip, so static hosts serve them as files.
        ...docsManifestPages(manifest).map(page => docsRawPath(page.path)),
        "/api/_docs/search.json",
        "/sitemap.xml",
        // Content serves the agent indexes per request. Their pages are known at build time.
        "/sitemap.md",
        "/llms.txt",
        "/llms-full.txt",
      ]
    }

    // Nuxt types Nitro hooks only when Nitro's types load.
    Reflect.apply(nuxt.hook, nuxt, ["nitro:init", (nitro: NitroInstance) => {
      const building = !nuxt.options.dev && !Reflect.get(nuxt.options, "_prepare")
      // All nitro:config hooks have run, including those registered by modules installed after the docs module.
      if (options.linkChecker !== false && building) {
        const problems = docsRedirectProblems(manifest, docsRedirects(nitro.options.routeRules ?? {}))
        if (problems.length) throw new DocsRedirectError(problems)
        nitro.hooks?.hook("compiled", () => {
          if (!nitro.options.output) return
          const redirects = docsRedirects(nitro.options.routeRules ?? {})
          const settings = options.linkChecker || {}
          const result = checkDocsLinks({ dir: nitro.options.output.publicDir, siteUrl: config.site.url || "https://docs.local", appBase: config.appBase, ...settings, isRuntimePath: docsRuntimePath(nitro.options, config.appBase, docsMount(manifest)), excludeLinks: [
            ...moduleOptions.linkChecker?.excludeLinks ?? [],
            ...settings.excludeLinks ?? [],
            ...redirects.map(redirect => docsAppPath(redirect.from, config.appBase)),
            // The MCP endpoint is a server route, so the built output has no file for it.
            ...config.mcp ? [docsAppPath("/mcp", config.appBase)] : [],
          ] })
          useLogger("@vite-hub/docs").info?.(`Checked links and fragments of ${result.pages} pages`)
        })
      }
      const seoAudit = options.seoAudit ?? "warn"
      if (seoAudit && building) {
        // Only what the check needs stays in memory, not the HTML of every page.
        const origin = `${config.site.url || "http://docs.invalid"}${config.appBase.replace(/\/+$/, "")}`
        const pages: DocsSeoPage[] = []
        let sitemap: string[] = []
        nitro.hooks?.hook("prerender:generate", (route) => {
          if (route.error || !route.contents) return
          if (route.route === "/sitemap.xml") sitemap = docsSitemapPaths(route.contents, origin)
          else if (route.fileName?.endsWith(".html") && route.contentType?.includes("text/html")) pages.push(readDocsSeoPage(route.route, route.contents, origin))
        })
        nitro.hooks?.hook("prerender:done", () => {
          const problems = docsSeoProblems(pages, sitemap)
          if (!problems.length) return
          const error = new DocsSeoError(problems)
          if (seoAudit === "error" || seoAudit === true) throw error
          useLogger("@vite-hub/docs").warn(`${error.message}\nSet \`docs.seoAudit\` to "error" to stop the build on these, or to false to turn the check off.`)
        })
      }
    }])
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
      // The `/raw/**` route goes to Nitro directly: nuxt-agent-discovery skips the prerender of raw copies that an app
      // route of Nuxt serves, and the build prerenders them.
      nitro.handlers = [...nitro.handlers ?? [], ...(["get", "head"] as const).map(method => ({ route: "/raw/**", method, handler: resolver.resolve("./runtime/server/raw.js") }))]
      nitro.alias = { ...nitro.alias, "#docs/manifest": manifestFile, "#docs/content": contentFile, "#docs/parser": parserFile, "#docs/example-sources": exampleSourcesFile, "#docs/agent": agentFile }
      // Pack production files into one module to stay below Cloudflare's module limit. Development reads server assets.
      const stores = [...sourceDirs ? sourceDirs.map((dir, index) => ({ name: `docs-${index}`, dir })) : [{ name: "docs", dir: contentDir }], { name: "docs-agent", dir: agentDir }]
      if (nuxt.options.dev) {
        nitro.serverAssets = [...nitro.serverAssets ?? [], ...stores.map(store => ({ baseName: store.name, dir: store.dir, pattern: "**/*.md" }))]
        nitro.virtual = { ...nitro.virtual, "#docs/files": "export default null\n" }
      }
      else {
        const order = () => docsManifestPages(manifest).flatMap((page): Array<[string, string]> => [[page.source ?? "docs", page.file], ["docs-agent", `${docsContentSource(page)}/${page.file}`]])
        nitro.virtual = { ...nitro.virtual, "#docs/files": () => docsFilesModule(stores, order()) }
      }
      nitro.publicAssets = [...nitro.publicAssets ?? [], { baseURL: "/_docs", dir: stylesDir, maxAge: 31_536_000 }]
      // `docs/kv.html` beside the `docs/kv/` folder, and every linked page, as static hosts expect. Development
      // prerenders nothing, and Nuxt would turn listed routes into prerender route rules there.
      // Docs below a prefix of an app list every page and crawl nothing, so the build does not prerender the app's
      // own pages that the docs link to, such as its home page.
      nitro.prerender = defu(nitro.prerender, { crawlLinks: docsMount(manifest) === "/", autoSubfolderIndex: false, routes: nuxt.options.dev ? [] : prerenderRoutes() })
      // A page with `seo.index: false` renders on request, so a site with thousands of them still builds fast. The
      // crawler would otherwise follow the links to them.
      const unindexed = new Set(docsManifestPages(manifest).filter(page => !docsPageIndexed(page)).flatMap(page => [page.path, `/api/_docs/page${page.path}.json`]))
      if (unindexed.size) {
        const prefix = config.appBase.replace(/\/+$/, "")
        nitro.prerender.ignore = [...nitro.prerender.ignore ?? [], (path: string) => {
          const route = path.split(/[?#]/)[0]!
          return unindexed.has(normalizeDocsPath(prefix && route.startsWith(`${prefix}/`) ? route.slice(prefix.length) : route))
        }]
      }
    }])
  },
})

/** Match Nitro's prerender policy, including the Console exclusions installed by vite-hub/nuxt. */
function docsRuntimePath(nitro: NitroOptions, appBase: string, mount: string): (pathname: string) => boolean {
  const routes = createRouter<{ prerender?: boolean }>()
  for (const [path, rule] of Object.entries(nitro.routeRules ?? {})) addRoute(routes, undefined, path, rule)
  const ignored = (nitro.prerender?.ignore ?? []).map(pattern => typeof pattern === "string"
    ? /[*:]/.test(pattern) ? routeToRegExp(pattern) : (path: string) => path.startsWith(pattern)
    : pattern)
  const base = appBase.replace(/\/+$/, "")
  return (pathname) => {
    const appPath = pathname === base ? "/" : pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : undefined
    // Nitro can hand ignore filters either the public path or the path with app.baseURL removed.
    if ([...new Set([pathname, appPath])].some(path => path !== undefined && ignored.some(pattern => {
      if (typeof pattern === "function") return pattern(path) === true
      pattern.lastIndex = 0
      return pattern.test(path)
    }))) return true
    if (appPath === undefined) return false
    // Docs below a prefix share the site with the app. The app renders its own pages, such as `/`, on request, and the
    // build crawls none of them. The Markdown copies below `/raw` are files, so links to them are still checked.
    if (mount !== "/" && !isDocsPath(appPath, mount) && !appPath.startsWith("/raw/")) return true
    // Match Nitro's precedence: a more specific explicit true overrides a broader false.
    return findAllRoutes(routes, undefined, appPath).reverse().find(route => route.data.prerender !== undefined)?.data.prerender === false
  }
}

/** Icons of the shell components. The icons of the theme come from `vitehubTheme`. */
const shellIcons = [
  "i-lucide-arrow-left", "i-lucide-arrow-right", "i-lucide-book-open", "i-lucide-check", "i-lucide-chevron-down", "i-lucide-chevron-right", "i-lucide-copy", "i-lucide-file",
  "i-lucide-folder-open", "i-lucide-link", "i-lucide-panel-left", "i-lucide-plug", "i-lucide-search", "i-lucide-x",
  "i-simple-icons-anthropic", "i-simple-icons-claude", "i-simple-icons-cursor", "i-simple-icons-windsurf",
  "i-simple-icons-github", "i-simple-icons-markdown", "i-simple-icons-openai", "i-simple-icons-visualstudiocode",
  "i-vscode-icons-file-type-dotenv", "i-vscode-icons-file-type-js", "i-vscode-icons-file-type-js-official", "i-vscode-icons-file-type-json", "i-vscode-icons-file-type-markdown",
  "i-vscode-icons-file-type-nuxt", "i-vscode-icons-file-type-node", "i-vscode-icons-file-type-text", "i-vscode-icons-file-type-typescript",
  "i-vscode-icons-file-type-vue", "i-vscode-icons-file-type-yaml",
]

/**
 * `i-lucide-sun` as @nuxt/icon bundles it: `lucide:sun`. Collection names with one hyphen end in `-icons`, such as
 * `simple-icons`. Rail icon names such as `kv` are not Iconify names and return `null`.
 */
function iconifyName(icon: string): string | null {
  const match = /^i-([a-z0-9]+(?:-icons)?)-(.+)$/.exec(icon)
  return match ? `${match[1]}:${match[2]}` : icon.includes(":") ? icon : null
}

/** The head of every page of a docs site. */
function setDocsHead(head: Nuxt["options"]["app"]["head"], siteName: string): void {
  const meta = head.meta ??= []
  const viewport = meta.find(tag => tag.name === "viewport")
  // Content may use the area around a notch, and `100dvh` shrinks when the phone keyboard opens. A viewport that
  // the app set itself stays.
  if (!viewport?.content || viewport.content === "width=device-width, initial-scale=1") {
    if (viewport) meta.splice(meta.indexOf(viewport), 1)
    meta.push({ name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" })
  }
  meta.push({ name: "color-scheme", content: "light dark" })
  // The design applies below `.vh-docs`. A docs site has it on every page, the error page too.
  head.htmlAttrs = { lang: "en", dir: "ltr", ...head.htmlAttrs, class: [head.htmlAttrs?.class, "vh-docs"].filter(Boolean).join(" ") }
  // `app.vue` sets the full title template. The error page uses this one: "Page not found · ViteHub".
  head.titleTemplate ??= `%s · ${siteName}`
}

/** Whether a layer has an `app.vue`, as Nuxt looks for it: `app` or `App` with any Nuxt extension. */
function hasAppComponent(srcDirs: string[], extensions: string[]): boolean {
  return srcDirs.some(dir => ["app", "App"].some(name => extensions.some(extension => existsSync(join(dir, `${name}${extension}`)))))
}

/** The docs pages need Nuxt UI's `<UApp>` and a `<NuxtLayout>` in the app's own `app.vue`. Say so when one is missing. */
function warnAppComponent(file: string): void {
  if (!existsSync(file)) return
  const source = readFileSync(file, "utf8")
  const missing = [/<(UApp|u-app)\b/.test(source) ? null : "`<UApp>`, which Nuxt UI needs for search, tooltips, and menus", /<(NuxtLayout|nuxt-layout)\b/.test(source) ? null : "`<NuxtLayout>`, which draws the docs navigation"].filter(Boolean)
  if (missing.length) useLogger("@vite-hub/docs").warn(`${file} has no ${missing.join(", and no ")}. Wrap \`<NuxtPage />\` in both, or remove app.vue to use the docs one.`)
}

/** Whether a stylesheet of the app imports Nuxt UI, and so starts a Tailwind build of its own. */
function importsNuxtUi(css: ReadonlyArray<string | { src?: string }>, alias: Record<string, string>, docsCss: string): boolean {
  return css.some((entry) => {
    const src = typeof entry === "string" ? entry : entry.src
    if (!src?.endsWith(".css") || src === docsCss) return false
    const prefix = Object.keys(alias).filter(key => src.startsWith(`${key}/`)).sort((left, right) => right.length - left.length)[0]
    const file = prefix ? join(alias[prefix]!, src.slice(prefix.length)) : src
    return existsSync(file) && /@import\s+["']@nuxt\/ui["']/.test(readFileSync(file, "utf8"))
  })
}

/** A module that this package depends on, by file path, so Nuxt finds it and transpiles its runtime. */
function dependency(name: string): string {
  return fileURLToPath(import.meta.resolve(name))
}

/** The file a CSS `@import "<name>"` loads: the package's `style` export. */
function stylesheet(name: string): string {
  // `@nuxt/ui` does not export its package.json, so walk up from its entry.
  let root = dirname(fileURLToPath(import.meta.resolve(name)))
  while (!existsSync(join(root, "package.json")) || JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name !== name) {
    // Internal invariant: a package that resolved has a package.json above its entry.
    if (dirname(root) === root) throw new Error(`Cannot find the package.json of ${name}.`)
    root = dirname(root)
  }
  const { exports } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: { ".": { style: string } } }
  return join(root, exports["."].style)
}

function docsLogo(logo: DocsSiteOptions["logo"], appBase: string): DocsLogo | null {
  if (!logo) return null
  if (typeof logo === "string") return { src: docsAppPath(logo, appBase), dark: null, mask: true }
  return { src: docsAppPath(logo.light, appBase), dark: logo.dark ? docsAppPath(logo.dark, appBase) : null, mask: false }
}

const docsRuntimeConfigTypes = `import type { DocsPublicConfig } from "@vite-hub/docs"

declare module "nuxt/schema" {
  interface PublicRuntimeConfig { docs: DocsPublicConfig }
}
declare module "@nuxt/schema" {
  interface PublicRuntimeConfig { docs: DocsPublicConfig }
}

export {}
`

function publicConfig(options: DocsModuleOptions, base: string, appBase: string): DocsPublicConfig {
  const site = options.site ?? {}
  const url = (site.url ?? "").replace(/\/+$/, "")
  const dir = options.dir ?? "content"
  return {
    appBase: docsAppPath("/", appBase),
    base,
    site: {
      name: site.name ?? "Docs",
      url,
      description: site.description ?? "",
      logo: docsLogo(site.logo, appBase),
      badge: site.badge ? { label: site.badge.label, tooltip: site.badge.tooltip ?? null } : null,
    },
    categories: options.categories ?? [],
    railExclude: options.railExclude ?? [],
    groups: options.groups ?? [],
    start: options.start ? { section: options.start.section, links: options.start.links ?? [] } : undefined,
    socials: options.socials ?? [],
    footer: options.footer ?? [],
    banner: options.banner ?? null,
    sitemap: options.sitemap ?? [],
    github: options.github ? { branch: "main", dir, ...options.github, url: `https://github.com/${options.github.repo}`, stars: null } : false,
    icons: { rail: {}, sections: {}, pages: {}, aliases: {}, family: "", page: "i-lucide-file-text", section: "i-lucide-folder", stroke: 1.5, ...options.icons },
    mcp: options.mcp === false ? false : { name: options.mcp?.name ?? (site.name ?? "docs").toLowerCase(), url: `${url}${docsAppPath("/mcp", appBase)}`, guide: options.mcp?.guide ?? null },
    assistant: options.assistant ? { agent: options.assistant === true ? "docs" : options.assistant.agent ?? "docs" } : false,
    ogImage: options.ogImage === false ? false : { component: options.ogImage?.component ?? "DocsPage" },
  }
}

/**
 * The stylesheets of the comark-* packages that comark-ui renders with, in one file. It names the layer order first,
 * the same as the app's CSS, so it can load before or after it.
 */
function comarkStylesheet(): string {
  const layers = "@layer theme, base, comark, components, utilities;"
  let ui: string
  try {
    ui = createRequire(import.meta.url).resolve("comark-ui/package.json")
  }
  catch {
    // An app that installs the module without its dependencies, as the module tests do, gets the layer order alone.
    return layers
  }
  const dependencies = Object.keys((JSON.parse(readFileSync(ui, "utf8")) as { dependencies?: Record<string, string> }).dependencies ?? {})
  const fromUi = createRequire(ui)
  const sheets = dependencies.filter(name => name.startsWith("comark-")).flatMap((name) => {
    try {
      return [readFileSync(fromUi.resolve(`${name}/style.css`), "utf8")]
    }
    catch {
      return []
    }
  })
  return [layers, ...sheets].join("\n")
}

// The header shows the star count next to the GitHub link. One request per build; a failure only drops the count.
async function githubStars(repo: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    const stars = typeof body === "object" && body !== null && "stargazers_count" in body ? body.stargazers_count : null
    return typeof stars === "number" ? stars : null
  }
  catch {
    return null
  }
}

export default docsNuxtModule
