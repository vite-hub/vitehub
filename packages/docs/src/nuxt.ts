import { mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  addComponent,
  addComponentsDir,
  addImportsDir,
  addRouteMiddleware,
  addServerHandler,
  addTemplate,
  createResolver,
  defineNuxtModule,
  extendPages,
} from "@nuxt/kit"
import { defu } from "defu"

import { setupDocsAssistant } from "./assistant-nuxt.ts"
import { createDocsManifest } from "./manifest.ts"
import { docsManifestPages, docsPageIcon, docsRailIcon, docsSectionIcon, type DocsIcons, type DocsLink } from "./navigation.ts"
import { toRawMarkdown } from "./raw.ts"
import { vercelTheme } from "./theme.ts"

import type { DocsPage } from "./types.ts"

/** The look of the site: tokens, typography, and the shape of the shell. */
export type DocsTheme = "vercel"

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
  /** Defaults to `vercel`, the only theme today. */
  theme?: DocsTheme
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
  /** The docs assistant: an Agent that answers from these pages. `true` uses the Agent named `docs`. */
  assistant?: boolean | { agent?: string }
  /**
   * Rewrites a page's Markdown before it becomes the copy that agents read at `/raw/<page>.md`, for example to expand
   * a component into plain Markdown. The built-in rewrites run after it. Runs at build time.
   */
  rawMarkdown?: (markdown: string, page: DocsPage) => string | Promise<string>
}

/** Options as the client and the server read them from `runtimeConfig.public.docs`. */
export interface DocsPublicConfig {
  base: string
  site: { name: string, url: string, description: string, logo: string | null, badge: { label: string, tooltip: string | null } | null }
  categories: string[]
  railExclude: string[]
  start: { section: string, links: DocsLink[] } | null
  socials: DocsLink[]
  banner: string | null
  sitemap: string[]
  github: { repo: string, branch: string, dir: string, url: string } | false
  icons: DocsIcons
  mcp: { name: string, url: string, guide: string | null } | false
  assistant: { agent: string } | false
}

interface NitroOptions {
  alias?: Record<string, string>
  serverAssets?: Array<{ baseName: string, dir: string, pattern?: string }>
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean, maxAge?: number }>
  prerender?: { crawlLinks?: boolean, autoSubfolderIndex?: boolean }
  experimental?: { asyncContext?: boolean }
  externals?: { inline?: Array<string | RegExp> | boolean }
}

interface AgentDiscoveryOptions {
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
  appConfig: { ui?: Record<string, unknown> }
  runtimeConfig: { public: { mdc?: unknown } }
  docs?: DocsModuleOptions
  agentDiscovery?: AgentDiscoveryOptions
  llms?: LlmsOptions
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
  moduleDependencies: (nuxt) => {
    const { docs }: DocsNuxtOptions = nuxt.options
    return {
      // Pages render with Nuxt UI prose components, and search and the outline are Nuxt UI content components.
      // A peer dependency: the app's own copy, so the app and the shell share one Nuxt UI.
      "@nuxt/ui": { defaults: { prose: true, content: true } },
      [dependency("@vite-hub/ui/nuxt")]: {},
      [dependency("nuxt-llms")]: {},
      [dependency("nuxt-agent-discovery")]: {},
      // The toolkit's own llms.txt block repeats what nuxt-agent-discovery writes.
      ...docs?.mcp === false ? {} : { [dependency("@nuxtjs/mcp-toolkit")]: { defaults: { name: docs?.site?.name ?? "Docs", llms: false } } },
    }
  },
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const runtime = resolver.resolve("./runtime")
    const contentDir = resolve(nuxt.options.rootDir, options.dir ?? "content")
    const rawDir = join(nuxt.options.buildDir, "docs/raw")
    const config = publicConfig(options)
    nuxt.options.runtimeConfig.public.docs = config
    setupDocsAssistant(nuxt, config)
    if (config.assistant) {
      // The panel calls `useChat()` from `vite-hub/nuxt`, so it is registered only when the assistant is on.
      for (const name of ["DocsAssistant", "DocsAssistantPanel"]) addComponent({ name, filePath: join(runtime, `app/assistant/${name}.vue`) })
    }
    const moduleOptions: DocsNuxtOptions = nuxt.options

    let manifest = createDocsManifest({ dir: contentDir, base: config.base })
    /** Writes the agent copy of every page. `nuxi build` empties the build folder after the modules load, so it runs before the build. */
    async function writeRaw() {
      rmSync(rawDir, { force: true, recursive: true })
      for (const page of docsManifestPages(manifest)) {
        const target = join(rawDir, page.path === "/" ? "index.md" : `${page.path.slice(1)}.md`)
        mkdirSync(dirname(target), { recursive: true })
        const source = readFileSync(join(contentDir, page.file), "utf8")
        writeFileSync(target, toRawMarkdown(options.rawMarkdown ? await options.rawMarkdown(source, page) : source, { siteUrl: config.site.url }))
      }
    }
    nuxt.hook("build:before", writeRaw)

    // Nuxt UI prose headings read the heading anchor settings of @nuxtjs/mdc, which this site does not install.
    moduleOptions.runtimeConfig.public.mdc ??= { headings: { anchorLinks: { h1: false, h2: true, h3: true, h4: true, h5: false, h6: false } } }
    // The app config of the app wins over the theme. Nuxt UI adds its defaults after the theme.
    moduleOptions.appConfig.ui = defu(moduleOptions.appConfig.ui, vercelTheme(config.site.name))

    moduleOptions.llms = defu(moduleOptions.llms, {
      domain: config.site.url,
      title: config.site.name,
      description: config.site.description,
      full: { title: config.site.name, description: config.site.description },
    })
    const discovery: AgentDiscoveryOptions = {
      source: join(runtime, "server/agent-source.js"),
      siteName: config.site.name,
      discovery: {
        links: [{ href: "/sitemap.xml", rel: "sitemap", type: "application/xml", title: "Sitemap (XML)" }],
        mcpServerCard: config.mcp ? { endpoint: "/mcp", name: config.mcp.name } : false,
      },
    }
    const agentDiscoveryOptions: AgentDiscoveryOptions = defu(moduleOptions.agentDiscovery, discovery)
    // A page outside the manifest has no Markdown twin, so by default only the manifest pages negotiate.
    if (!agentDiscoveryOptions.routes?.length) {
      const standalone = manifest.pages.map(page => page.path).filter(path => path !== "/")
      agentDiscoveryOptions.routes = ["/", config.base, `${config.base}/**`, ...standalone]
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
    const contentEntry = findContentEntry(nuxt.options.serverDir)
    const contentFile = addTemplate({
      filename: "docs/content.mjs",
      write: true,
      getContents: () => contentEntry ? `export { content } from ${JSON.stringify(contentEntry)}\n` : "export const content = undefined\n",
    }).dst

    // Nuxt watches the app folder, and the content folder usually sits beside it, so the module watches it in development.
    if (nuxt.options.dev) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const watcher = watch(contentDir, { recursive: true }, (_event, file) => {
        if (!file || !/(\.md|\.navigation\.yml)$/.test(file)) return
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const next = createDocsManifest({ dir: contentDir, base: config.base })
          const changed = JSON.stringify(next) !== JSON.stringify(manifest)
          manifest = next
          await writeRaw()
          // A body edit shows on the next page load, because pages parse on each request in development. Titles,
          // order, and new pages live in the manifest that the app and the server load once, so they restart.
          if (changed) await nuxt.callHook("restart")
        }, 100)
      })
      nuxt.hook("close", () => watcher.close())
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
        `@import "${join(runtime, "theme", `${options.theme ?? "vercel"}.css`)}";`,
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
    const contentDirs = [join(runtime, "app/components/content"), ...nuxt.options._layers.map(layer => join(layer.config.srcDir, "components/content"))]
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
    addRouteMiddleware({ name: "docs-layout", path: join(runtime, "app/middleware/docs-layout.ts"), global: true })
    extendPages((pages) => {
      if (pages.some(page => page.path.includes(":slug(.*)*") || page.path.includes("(.*)"))) return
      pages.push({ name: "docs-page", path: "/:slug(.*)*", file: join(runtime, "app/pages/docs-page.vue") })
    })
    nuxt.hook("app:resolve", (app) => {
      if (!app.mainComponent || app.mainComponent.includes("@nuxt/ui-templates") || app.mainComponent.includes("nuxt/dist/app/components/welcome")) app.mainComponent = join(runtime, "app/app.vue")
      if (!app.errorComponent || app.errorComponent.includes("nuxt/dist/app/components/nuxt-error-page")) app.errorComponent = join(runtime, "app/error.vue")
    })

    addServerHandler({ route: "/api/_docs/page/**", handler: resolver.resolve("./runtime/server/page.js") })
    addServerHandler({ route: "/api/_docs/search.json", handler: resolver.resolve("./runtime/server/search.js") })
    addServerHandler({ route: "/sitemap.xml", handler: resolver.resolve("./runtime/server/sitemap.js") })
    // The raw copy is the file as written, without the frontmatter that nuxt-agent-discovery adds to its own raw route.
    addServerHandler({ route: "/raw/**", method: "get", handler: resolver.resolve("./runtime/server/raw.js") })

    // Nuxt types `nitro:config` only when Nitro's types load.
    Reflect.apply(nuxt.hook, nuxt, ["nitro:config", (nitro: NitroOptions) => {
      nitro.alias = { ...nitro.alias, "#docs/manifest": manifestFile, "#docs/content": contentFile }
      // Nitro 2 development leaves absolute modules outside the app to Node. Bundle the generated modules, so the page
      // route reads the same Content runtime as ViteHub's Content routes instead of a second copy of `server/content.ts`.
      const inline = nitro.externals?.inline
      if (inline !== true) nitro.externals = { ...nitro.externals, inline: [...Array.isArray(inline) ? inline : [], dirname(manifestFile)] }
      // Pages are read at runtime, so a host without a file system serves them too.
      nitro.serverAssets = [...nitro.serverAssets ?? [], { baseName: "docs", dir: contentDir, pattern: "**/*.md" }, { baseName: "docs-raw", dir: rawDir }]
      // A removed page has no raw file. Fall through so a redirect route rule answers it.
      nitro.publicAssets = [...nitro.publicAssets ?? [], { baseURL: "/raw", dir: rawDir, fallthrough: true, maxAge: 300 }]
      // `docs/kv.html` beside the `docs/kv/` folder, and every linked page, as static hosts expect.
      nitro.prerender = defu(nitro.prerender, { crawlLinks: true, autoSubfolderIndex: false })
      // The MCP toolkit reads the current request through Nitro's async context.
      if (config.mcp) nitro.experimental = defu(nitro.experimental, { asyncContext: true })
    }])
    nuxt.hook("prerender:routes", ({ routes }) => {
      for (const page of docsManifestPages(manifest)) {
        routes.add(page.path)
        // Client navigation reads the parsed page, so static hosts serve it instead of parsing on each request.
        routes.add(`/api/_docs/page${page.path === "/" ? "/index" : page.path}.json`)
      }
      routes.add("/api/_docs/search.json")
      routes.add("/sitemap.xml")
      // nuxt-agent-discovery serves the Markdown sitemap per request. Its pages are known at build time.
      routes.add("/sitemap.md")
    })
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

/** `server/content.ts` (or `.js`, `.mts`, and so on), as `findContentEntry()` of `@vite-hub/source/vite` finds it. */
function findContentEntry(serverDir: string): string | undefined {
  let names: string[]
  try {
    names = readdirSync(serverDir)
  }
  catch {
    return
  }
  const name = names.filter(entry => /^content\.[cm]?[jt]s$/.test(entry)).sort()[0]
  return name ? join(serverDir, name) : undefined
}

/** A module that this package depends on, by file path, so Nuxt finds it and transpiles its runtime. */
function dependency(name: string): string {
  return fileURLToPath(import.meta.resolve(name))
}

function publicConfig(options: DocsModuleOptions): DocsPublicConfig {
  const site = options.site ?? {}
  const url = (site.url ?? "").replace(/\/+$/, "")
  const dir = options.dir ?? "content"
  return {
    base: options.base ?? "/docs",
    site: {
      name: site.name ?? "Docs",
      url,
      description: site.description ?? "",
      logo: site.logo ?? null,
      badge: site.badge ? { label: site.badge.label, tooltip: site.badge.tooltip ?? null } : null,
    },
    categories: options.categories ?? [],
    railExclude: options.railExclude ?? [],
    start: options.start ? { section: options.start.section, links: options.start.links ?? [] } : null,
    socials: options.socials ?? [],
    banner: options.banner ?? null,
    sitemap: options.sitemap ?? [],
    github: options.github ? { branch: "main", dir, ...options.github, url: `https://github.com/${options.github.repo}` } : false,
    icons: { rail: {}, sections: {}, pages: {}, aliases: {}, family: "", page: "i-lucide-file-text", section: "i-lucide-folder", ...options.icons },
    mcp: options.mcp === false ? false : { name: options.mcp?.name ?? (site.name ?? "docs").toLowerCase(), url: `${url}/mcp`, guide: options.mcp?.guide ?? null },
    assistant: options.assistant ? { agent: options.assistant === true ? "docs" : options.assistant.agent ?? "docs" } : false,
  }
}

export default docsNuxtModule
