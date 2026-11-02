import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

import {
  addComponentsDir,
  addImportsDir,
  addLayout,
  addServerHandler,
  addServerTemplate,
  addTemplate,
  createResolver,
  defineNuxtModule,
  extendPages,
  installModule,
  updateTemplates,
} from "@nuxt/kit"

import { createDocsManifest } from "./manifest.ts"
import { docsManifestPages } from "./page.ts"
import { toRawMarkdown } from "./raw.ts"

import type { DocsManifest, DocsPage } from "./types.ts"

/** The look of the site: tokens, typography, and the shape of the shell. */
export type DocsTheme = "vercel"

export interface DocsSiteOptions {
  /** Name in titles, the rail, and llms.txt. */
  name?: string
  /** Canonical origin, such as `https://vitehub.dev`. Raw Markdown links and the sitemap use it. */
  url?: string
  description?: string
}

export interface DocsModuleOptions {
  /** Folder of Markdown pages, relative to the app root. Defaults to `content`. */
  dir?: string
  /** URL prefix whose folders are sections in the rail. Defaults to `/docs`. */
  base?: string
  site?: DocsSiteOptions
  /** Defaults to `vercel`, the only theme today. */
  theme?: DocsTheme
  /** Order of section categories in the rail and the catalog. Sections of other categories come after them. */
  categories?: string[]
  /** Categories that the catalog lists but the rail leaves out, such as shared reference topics. */
  railExclude?: string[]
  /** "Edit this page" links. `dir` is the content folder inside the repository. */
  github?: { repo: string, branch?: string, dir?: string } | false
  /** The docs assistant: an Agent that answers from these pages. `true` uses the Agent named `docs`. */
  assistant?: boolean | { agent?: string }
  /**
   * Rewrites a page's Markdown before it becomes the copy that agents read at `/raw/<page>.md`, for example to expand
   * a component into plain Markdown. The built-in rewrites run after it. Runs at build time.
   */
  rawMarkdown?: (markdown: string, page: DocsPage) => string
}

/** Options as the client and the server read them from `runtimeConfig.public.docs`. */
export interface DocsPublicConfig {
  base: string
  site: Required<DocsSiteOptions>
  categories: string[]
  railExclude: string[]
  github: { repo: string, branch: string, dir: string } | false
  assistant: { agent: string } | false
}

interface NitroAssets {
  serverAssets?: Array<{ baseName: string, dir: string, pattern?: string }>
  publicAssets?: Array<{ baseURL?: string, dir: string, fallthrough?: boolean, maxAge?: number }>
}

export interface DocsNuxtModule {
  (inlineOptions: DocsModuleOptions, nuxt: never): unknown
  getMeta?: () => Promise<Record<string, unknown>>
}

const docsNuxtModule: DocsNuxtModule = defineNuxtModule<DocsModuleOptions>({
  meta: { configKey: "docs", name: "@vite-hub/docs" },
  defaults: {},
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const runtime = resolver.resolve("./runtime")
    const contentDir = resolve(nuxt.options.rootDir, options.dir ?? "content")
    const rawDir = join(nuxt.options.buildDir, "docs/raw")
    const config: DocsPublicConfig = {
      base: options.base ?? "/docs",
      site: { name: options.site?.name ?? "Docs", url: options.site?.url ?? "", description: options.site?.description ?? "" },
      categories: options.categories ?? [],
      railExclude: options.railExclude ?? [],
      github: options.github ? { branch: "main", dir: options.dir ?? "content", ...options.github } : false,
      assistant: options.assistant ? { agent: options.assistant === true ? "docs" : options.assistant.agent ?? "docs" } : false,
    }
    nuxt.options.runtimeConfig.public.docs = config

    let manifest: DocsManifest = build()
    function build(): DocsManifest {
      const next = createDocsManifest({ dir: contentDir, base: config.base })
      writeRaw(next)
      return next
    }
    function writeRaw(next: DocsManifest) {
      rmSync(rawDir, { force: true, recursive: true })
      for (const page of docsManifestPages(next)) {
        const target = join(rawDir, page.path === "/" ? "index.md" : `${page.path.slice(1)}.md`)
        mkdirSync(dirname(target), { recursive: true })
        const source = readSource(contentDir, page)
        writeFileSync(target, toRawMarkdown(options.rawMarkdown ? options.rawMarkdown(source, page) : source, { siteUrl: config.site.url }))
      }
    }

    await installModule("@vite-hub/ui/nuxt", {}, nuxt)

    // The manifest is data, not code: the app and the server import the same JSON.
    const manifestSource = () => `export default ${JSON.stringify(manifest)}\n`
    nuxt.options.alias["#docs/manifest"] = addTemplate({ filename: "docs/manifest.mjs", getContents: manifestSource, write: true }).dst
    addServerTemplate({ filename: "#docs/manifest", getContents: manifestSource })
    addTemplate({ filename: "docs/manifest.d.ts", getContents: () => `import type { DocsManifest } from "@vite-hub/docs"\ndeclare const manifest: DocsManifest\nexport default manifest\n`, write: true })
    nuxt.hook("prepare:types", ({ references }) => {
      references.push({ path: join(nuxt.options.buildDir, "docs/manifest.d.ts") })
    })

    nuxt.hook("builder:watch", async (_event, path) => {
      const file = relative(contentDir, resolve(nuxt.options.rootDir, path))
      if (file.startsWith("..") || !/(\.md|\.navigation\.yml)$/.test(file)) return
      manifest = build()
      await updateTemplates({ filter: template => template.filename.startsWith("docs/") })
    })

    // Tailwind scans the app; the docs components and the Markdown pages live outside it.
    nuxt.options.css.unshift(addTemplate({
      filename: "docs/docs.css",
      write: true,
      getContents: () => [
        `@import "tailwindcss";`,
        `@import "@nuxt/ui";`,
        `@source "${join(runtime, "app")}";`,
        `@source "${contentDir}";`,
        `@import "${join(runtime, "theme", `${options.theme ?? "vercel"}.css`)}";`,
        "",
      ].join("\n"),
    }).dst)

    addComponentsDir({ path: join(runtime, "app/components"), pathPrefix: false, priority: -1 })
    addImportsDir(join(runtime, "app/composables"))
    addLayout({ src: join(runtime, "app/layouts/docs.vue") }, "docs")
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

    // Nuxt types `nitro:config` only when Nitro's types load.
    Reflect.apply(nuxt.hook, nuxt, ["nitro:config", (nitro: NitroAssets) => {
      // Pages are read at runtime, so a host without a file system serves them too.
      nitro.serverAssets = [...nitro.serverAssets ?? [], { baseName: "docs", dir: contentDir, pattern: "**/*.md" }, { baseName: "docs-raw", dir: rawDir }]
      // A removed page has no raw file. Fall through so a redirect route rule answers it.
      nitro.publicAssets = [...nitro.publicAssets ?? [], { baseURL: "/raw", dir: rawDir, fallthrough: true, maxAge: 300 }]
    }])
    nuxt.hook("prerender:routes", ({ routes }) => {
      for (const page of docsManifestPages(manifest)) routes.add(page.path)
      routes.add("/api/_docs/search.json")
      routes.add("/sitemap.xml")
    })
  },
})

function readSource(dir: string, page: DocsPage): string {
  return readFileSync(join(dir, page.file), "utf8")
}

export default docsNuxtModule
