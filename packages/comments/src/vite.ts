import { execFile } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { addViteHubPageToolRoutes, viteHubPageToolsBase, viteHubPageToolsIndexHtml } from "@vite-hub/internal/build/page-tools"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { viteHubPageToolsCookie, viteHubPageToolsQuery } from "@vite-hub/internal/runtime/page-tools-shared"

import { commentsConsoleSection } from "./console.ts"
import { findCommentsEntry, findContentEntry } from "./entry.ts"
import { commentsRealtimeDefinition, commentsRoute } from "./page.ts"

import type { DatabaseContributionContext, DatabaseContributionEntry } from "@vite-hub/database/vite"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, UserConfig } from "vite"

export { commentsConsoleSection }
export { findCommentsEntry } from "./entry.ts"

/** Module paths that generated files import. The `vite-hub` distribution passes its own subpaths. */
export interface CommentsImports {
  /** Exports `defineCommentsPlugin`, `createCommentsHandler`, and `viteHubPageSessionHandler`. */
  runtime: string
  /** Exports `commentsRealtime`. */
  realtime: string
  /** Exports `commentsAuthSession`. */
  auth: string
  /** Exports `commentsSchema`. */
  database: string
  /** Exports `databases`, the runtime Database registry. */
  databases: string
  /** Exports `parseContentField`. */
  contentClient: string
}

export interface CommentsVitePluginOptions {
  /** Whether the app configures ViteHub Auth, so Comments reads its session. Default `false`. */
  auth?: boolean
  /**
   * The Console of the app: a module and its `consoleRealtimeAccess` export. With it, the people that the Console lets
   * use its `comments` section are the people of Comments, and opening the Console turns the page tools on for them.
   */
  console?: { module: string }
  imports?: Partial<CommentsImports>
}

export interface CommentsRealtimeContributionContext {
  authority: "cloudflare" | "memory"
  directory: string
  projectRoot: string
  serverDirs?: string[]
}

export type CommentsVitePlugin = Plugin & {
  api: {
    /**
     * The `comments` Realtime Definition of the page presence rooms, for `hubRealtime({ contribute })`. Realtime calls
     * it only when the host has a room authority; without one, pages show comments without presence.
     */
    contributeRealtime(context: CommentsRealtimeContributionContext): Promise<{ definitions: Array<{ handler: string, name: string }> } | undefined>
  }
  vitehub: ViteHubInspectionPluginMetadata & { databases: (context: DatabaseContributionContext) => Promise<DatabaseContributionEntry[]> }
}

const defaultImports: CommentsImports = {
  runtime: "@vite-hub/comments/runtime",
  realtime: "@vite-hub/comments/realtime",
  auth: "@vite-hub/comments/runtime/auth",
  database: "@vite-hub/comments/database",
  databases: "@vite-hub/database/drizzle",
  contentClient: "@vite-hub/content/client",
}

/**
 * The Database name in `defineComments({ database: "name" })`, read without running the file. Undefined means the
 * default or only Database.
 */
export async function readCommentsDatabase(file: string): Promise<string | undefined> {
  const source = await readFile(file, "utf8").catch(() => "")
  return /\bdatabase\s*:\s*["'`]([\w-]+)["'`]/.exec(source)?.[1]
}

/** A directory of prebuilt browser scripts in this package: `overlay`, or `page` for the page tools loader. */
function builtDirectory(name: "overlay" | "page"): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Built: dist/vite.js next to dist/<name>. From source in tests: src/vite.ts, so use the built copy.
  return here.endsWith("src") ? resolve(here, `../dist/${name}`) : resolve(here, name)
}

/** The directory of the prebuilt overlay script in this package. */
export function commentsOverlayDirectory(): string {
  return builtDirectory("overlay")
}

/** CI and host variables that name the commit and branch of a build, in the order they are read. */
const buildVariables: ReadonlyArray<readonly [commit: string, branch: string]> = [
  ["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_REF"],
  ["WORKERS_CI_COMMIT_SHA", "WORKERS_CI_BRANCH"],
  ["CF_PAGES_COMMIT_SHA", "CF_PAGES_BRANCH"],
  ["COMMIT_REF", "BRANCH"],
  ["GITHUB_SHA", "GITHUB_HEAD_REF"],
]

async function git(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("git", args, { cwd: root, encoding: "utf8", timeout: 3000 })
    return stdout.trim() || undefined
  }
  catch {
    return undefined
  }
}

/** The commit and branch of the build, from the CI or host, else from Git. Empty outside a Git checkout. */
export async function readCommentsBuild(root: string, env: Record<string, string | undefined> = process.env): Promise<{ commit?: string, branch?: string }> {
  for (const [commitName, branchName] of buildVariables) {
    const commit = env[commitName]
    if (!commit) continue
    const branch = env[branchName] || (commitName === "GITHUB_SHA" ? env.GITHUB_REF_NAME : undefined)
    return branch ? { commit, branch } : { commit }
  }
  const [commit, branch] = await Promise.all([git(root, ["rev-parse", "HEAD"]), git(root, ["rev-parse", "--abbrev-ref", "HEAD"])])
  return { ...(commit ? { commit } : {}), ...(branch && branch !== "HEAD" ? { branch } : {}) }
}

const skippedDirectories = new Set(["node_modules", "dist", "coverage", "public"])

const pascal = (segment: string): string => segment.replace(/(?:^|[-_.\s]+)(\w)/g, (_, letter: string) => letter.toUpperCase())

/**
 * The names that a production build may give the component of a `.vue` file: its file name, which `<script setup>`
 * uses; under `pages/`, the Nuxt route name, such as `blog-id` for `pages/blog/[id].vue`; under `components/`, the
 * Nuxt name, such as `ViewerThread` for `components/viewer/Thread.vue`.
 */
export function componentNames(file: string): string[] {
  const names = new Set([basename(file, ".vue")])
  const parts = file.replace(/\.vue$/, "").split("/")
  const pages = parts.lastIndexOf("pages")
  if (pages !== -1) {
    const route = parts.slice(pages + 1).filter(part => part !== "index" && !/^\(.*\)$/.test(part)).map(part => part.replace(/[[\].]/g, "")).join("-")
    names.add(route || "index")
  }
  const directory = parts.lastIndexOf("components")
  if (directory !== -1) {
    const segments = parts.slice(directory + 1).map(pascal)
    const last = segments.pop()!
    const prefix = segments.join("")
    names.add(last.startsWith(prefix) ? last : `${prefix}${last}`)
  }
  return [...names]
}

/**
 * The Vue files of a project by component name, relative to the project root. `<script setup>` components carry the
 * name of their file in production builds, so the name finds the file. It skips dot directories and build output.
 */
export async function readCommentsComponents(root: string, limit = 5000): Promise<Record<string, string[]>> {
  const components: Record<string, string[]> = {}
  let count = 0
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 12 || count >= limit) return
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else if (entry.isFile() && entry.name.endsWith(".vue") && count < limit) {
        count++
        const file = relative(root, path).split(sep).join("/")
        for (const name of componentNames(file)) {
          const files = components[name] ??= []
          if (!files.includes(file)) files.push(file)
        }
      }
    }
  }
  await walk(root, 0)
  return components
}

const overlayBaseURL = `${commentsRoute}/assets`
const version = "2"

/** Generated session reader: the Console user of a request, else the ViteHub Auth user. */
function sessionLines(options: CommentsVitePluginOptions, imports: CommentsImports): { imports: string[], value: string } {
  if (options.console) {
    return {
      imports: [
        `import { consoleRealtimeAccess } from ${JSON.stringify(options.console.module)}`,
        `import { commentsConsoleSession } from ${JSON.stringify(imports.runtime)}`,
      ],
      value: `commentsConsoleSession(consoleRealtimeAccess(${JSON.stringify(commentsConsoleSection.id)}))`,
    }
  }
  return options.auth
    ? { imports: [`import { commentsAuthSession } from ${JSON.stringify(imports.auth)}`], value: "commentsAuthSession" }
    : { imports: [], value: "undefined" }
}

export function renderCommentsHandler(input: { definition: string, content?: string, session: CommentsVitePluginOptions, realtime: boolean, imports: CommentsImports, build?: { commit?: string, branch?: string } }): string {
  const session = sessionLines(input.session, input.imports)
  return [
    `import { createCommentsHandler } from ${JSON.stringify(input.imports.runtime)}`,
    `import components from "./components.mjs"`,
    `import { comments } from ${JSON.stringify(pathToFileURL(input.definition).href)}`,
    ...session.imports,
    ...(input.content
      ? [
          `import * as contentModule from ${JSON.stringify(pathToFileURL(input.content).href)}`,
          `import { parseContentField } from ${JSON.stringify(input.imports.contentClient)}`,
        ]
      : []),
    "",
    "export default createCommentsHandler({",
    "  comments,",
    `  session: ${session.value},`,
    ...(input.content ? ["  content: contentModule.content ? { runtime: contentModule.content, parseField: parseContentField } : undefined,"] : []),
    `  realtime: ${input.realtime},`,
    `  build: ${JSON.stringify(input.build ?? {})},`,
    "  components,",
    "})",
    "",
  ].join("\n")
}

export function renderCommentsPlugin(input: { definition: string, database?: string, session: CommentsVitePluginOptions, imports: CommentsImports, base?: string }): string {
  const session = sessionLines(input.session, input.imports)
  return [
    `import { defineCommentsPlugin } from ${JSON.stringify(input.imports.runtime)}`,
    `import { databases } from ${JSON.stringify(input.imports.databases)}`,
    `import { comments } from ${JSON.stringify(pathToFileURL(input.definition).href)}`,
    ...session.imports,
    "",
    "// The Database that `defineComments({ database })` names, else `default`, else the only one.",
    "function database() {",
    `  const name = ${JSON.stringify(input.database ?? null)}`,
    "  if (name) return databases[name]?.db",
    "  // Without a default Database, `databases.default` is a placeholder that throws when read.",
    "  try {",
    "    if (databases.default.db.select) return databases.default.db",
    "  }",
    "  catch {}",
    "  const names = Object.keys(databases).filter(key => key !== \"default\")",
    "  return names.length === 1 ? databases[names[0]].db : undefined",
    "}",
    "",
    `export default defineCommentsPlugin({ comments, database, overlay: ${JSON.stringify(`${overlayBaseURL}/overlay.js?v=${version}`)}, base: ${JSON.stringify(input.base ?? "")}, session: ${session.value} })`,
    "",
  ].join("\n")
}

/**
 * Comments build integration. When the app has `server/comments.ts`, it serves the Comments API at
 * `<base>/api/_vitehub/comments/**`, installs the runtime with its Database, adds the tables to that Database, serves the
 * overlay script, and registers it as the `comments` page tool. It also serves the page tools session and loader at
 * `<base>/_vitehub/page`, so the overlay works without the Console, and adds the loader to the `index.html` of a single
 * page app. `<base>` is the app base, such as the Vite `base` or Nuxt `app.baseURL`. Apps without the file are
 * unaffected.
 */
export function hubComments(options: CommentsVitePluginOptions = {}): CommentsVitePlugin {
  const imports: CommentsImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  let realtime = false
  let appBase = ""
  const discover = () => findCommentsEntry(projectRoot ?? process.cwd(), serverDirs)

  return {
    name: "@vite-hub/comments/vite",
    api: {
      async contributeRealtime(context) {
        const definition = findCommentsEntry(context.projectRoot, context.serverDirs)
        if (!definition) return
        realtime = true
        const file = join(context.directory, "comments.mjs")
        const session = sessionLines(options, imports)
        await mkdir(context.directory, { recursive: true })
        await writeFile(file, [
          `import { commentsRealtime } from ${JSON.stringify(imports.realtime)}`,
          `import { comments } from ${JSON.stringify(pathToFileURL(definition).href)}`,
          ...session.imports,
          "",
          `export default commentsRealtime(comments, { session: ${session.value} })`,
          "",
        ].join("\n"))
        return { definitions: [{ handler: file, name: commentsRealtimeDefinition }] }
      },
    },
    vitehub: {
      inspect: () => ({
        definitions: [{
          kind: "comments",
          label: "Comments",
          list: () => {
            const definition = discover()
            if (!definition) return []
            return [{
              fields: [
                { label: "Route", value: `${commentsRoute}/**` },
                { label: "Presence", value: realtime ? `Realtime Definition "${commentsRealtimeDefinition}"` : "off: the host has no Realtime authority" },
                { label: "Page tool", value: `?${viteHubPageToolsQuery} or the ${viteHubPageToolsCookie} cookie, for people that authorize allows to read` },
              ],
              file: relativeDefinitionFile(projectRoot ?? process.cwd(), definition),
              name: "comments",
              source: "server-comments",
            }]
          },
        }],
      }),
      async databases(context) {
        const root = projectRoot ?? context.projectRoot ?? context.rootDir ?? context.root ?? process.cwd()
        const definition = findCommentsEntry(root, serverDirs ?? context.serverDirs?.slice())
        if (!definition) return []
        const database = await readCommentsDatabase(definition)
        return [{
          ...(database ? { database } : {}),
          definition: { export: "commentsSchema", module: imports.database },
          dialect: "sqlite",
          name: "comments",
          reason: "Stores the comment threads of `server/comments.ts`.",
        }]
      },
    },
    // `vitehub()` adds this plugin after Realtime, so Realtime's contribution says whether presence runs.
    enforce: "pre",
    config: {
      async handler(config) {
        // SAFETY: Vite passes its user config with ViteHub's shared keys attached.
        const viteConfig = config as UserConfig & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[] }
        projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(resolve(config.root || process.cwd()))
        serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice()
        const directory = resolve(projectRoot, ".vitehub/nitro/comments")
        const definition = discover()
        if (!definition) {
          await rm(directory, { force: true, recursive: true })
          return
        }
        const handler = join(directory, "handler.mjs")
        const plugin = join(directory, "plugin.mjs")
        const pageSession = join(directory, "page-session.mjs")
        const { base, mount } = viteHubPageToolsBase(config)
        appBase = base
        await mkdir(directory, { recursive: true })
        const [build, components] = await Promise.all([readCommentsBuild(projectRoot), readCommentsComponents(projectRoot)])
        await Promise.all([
          writeFile(handler, renderCommentsHandler({ definition, content: findContentEntry(projectRoot, serverDirs), session: options, realtime, imports, build })),
          writeFile(join(directory, "components.mjs"), `export default ${JSON.stringify(components)}\n`),
          writeFile(plugin, renderCommentsPlugin({ definition, database: await readCommentsDatabase(definition), session: options, imports, base })),
          writeFile(pageSession, `export { viteHubPageSessionHandler as default } from ${JSON.stringify(imports.runtime)}\n`),
        ])
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        kit.addHandler({ handler, route: `${mount}${commentsRoute}/**` })
        kit.addPlugin(plugin)
        addViteHubPageToolRoutes(kit, { handler: pageSession, loader: builtDirectory("page"), mount })
        const nitro = kit.config
        const assets = Array.isArray(nitro.publicAssets) ? [...nitro.publicAssets] : []
        const overlay = commentsOverlayDirectory()
        if (!assets.some(asset => Object(asset) === asset && Reflect.get(Object(asset), "dir") === overlay)) {
          assets.push({ baseURL: `${mount}${overlayBaseURL}`, dir: overlay, maxAge: 300 })
        }
        nitro.publicAssets = assets
        Reflect.set(config, "nitro", nitro)
      },
    },
    // A single page app whose `index.html` Vite serves or builds: load the page tools in the browser with the hint.
    transformIndexHtml(html) {
      return discover() ? viteHubPageToolsIndexHtml(html, appBase) : undefined
    },
  }
}
