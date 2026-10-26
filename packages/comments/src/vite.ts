import { execFile } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { includedNitro } from "@vite-hub/internal/build/included-nitro"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { parseDatabaseLocation } from "@vite-hub/database/connect"

import { commentsConsoleSection } from "./console.ts"
import { findCommentsEntry, findContentEntry } from "./entry.ts"
import { commentsHintCookie, commentsHintQuery, commentsRealtimeDefinition, commentsRoute } from "./page.ts"

import type { DatabaseContributionContext, DatabaseContributionEntry } from "@vite-hub/database/vite"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, PluginOption, UserConfig } from "vite"
import type { CommentBuild } from "./types.ts"

export { commentsConsoleSection }
export { findCommentsEntry } from "./entry.ts"

/** Module paths that generated files import. The `vite-hub` distribution passes its own subpaths. */
export interface CommentsImports {
  /** Exports `defineCommentsPlugin` and `createCommentsHandler`. */
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
  /** Exports `connectDatabase`, for Workers. Its `/node` subpath also opens SQLite files. */
  connect: string
}

/** Options of `comments()`, for apps that use Comments without `vite-hub`. */
export interface CommentsOptions {
  /**
   * Where threads are stored. Comments creates its tables there on first use, so there is no migration.
   *
   * - Not set: `DATABASE_URL`, else `TURSO_DATABASE_URL`, else the Cloudflare D1 binding `DB`, read at runtime.
   * - `"d1:COMMENTS"`: the Cloudflare D1 binding `COMMENTS`. Comments adds it to the Wrangler config.
   * - `"env:COMMENTS_DATABASE_URL"`: the libSQL URL in that variable, with its token in `COMMENTS_AUTH_TOKEN`.
   * - `"file:./data/comments.sqlite"`: a SQLite file on Node, relative to the server's working directory.
   *
   * The development server uses `.vitehub/data/comments.sqlite`, unless `database` is a file or a set variable.
   */
  database?: string
}

/** The storage of a `comments()` build: where to connect, the file to use without a connection, and whether it needs Node. */
export interface StandaloneDatabase {
  where?: string
  fallback?: string
  node: boolean
}

export interface CommentsVitePluginOptions {
  /** Whether the app configures ViteHub Auth, so Comments reads its session. Default `false`. */
  auth?: boolean
  /**
   * The Console of the app: a module and its `consoleRealtimeAccess` export. With it, the people that the Console lets
   * use its `comments` section are the people of Comments, and the Console turns comment mode on for them.
   */
  console?: { module: string }
  imports?: Partial<CommentsImports>
  /**
   * Comments without `vite-hub`, as `comments()` sets it: it turns on without `server/comments.ts`, keeps threads in a
   * SQLite file that it opens itself, and signs people in with GitHub.
   */
  standalone?: CommentsOptions
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
  connect: "@vite-hub/comments/runtime/connect",
}

/**
 * The Database name in `defineComments({ database: "name" })`, read without running the file. Undefined means the
 * default or only Database.
 */
export async function readCommentsDatabase(file: string): Promise<string | undefined> {
  const source = await readFile(file, "utf8").catch(() => "")
  return /\bdatabase\s*:\s*["'`]([\w-]+)["'`]/.exec(source)?.[1]
}

/** The directory of the prebuilt overlay script in this package. */
export function commentsOverlayDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Built: dist/vite.js next to dist/overlay. From source in tests: src/vite.ts, so use the built copy.
  return here.endsWith("src") ? resolve(here, "../dist/overlay") : resolve(here, "overlay")
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

/** `owner/name` of a GitHub remote URL, such as `git@github.com:owner/name.git`. */
export function githubRepository(remote: string | undefined): string | undefined {
  return remote ? /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1] : undefined
}

/** The pull request that the CI or host builds, when it names one. */
function pullRequestOf(env: Record<string, string | undefined>): number | undefined {
  const value = env.VERCEL_GIT_PULL_REQUEST_ID
    || (env.PULL_REQUEST === "true" ? env.REVIEW_ID : undefined)
    || /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "")?.[1]
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/**
 * The build of the app, from the CI or host, else from Git: the commit and branch, the GitHub repository, and the pull
 * request when the host names it. Empty outside a Git checkout.
 */
export async function readCommentsBuild(root: string, env: Record<string, string | undefined> = process.env): Promise<CommentBuild> {
  const repository = env.GITHUB_REPOSITORY
    || (env.VERCEL_GIT_PROVIDER === "github" && env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : undefined)
    || githubRepository(env.REPOSITORY_URL)
    || githubRepository(await git(root, ["remote", "get-url", "origin"]))
  const pullRequest = pullRequestOf(env)
  const extra = { ...(repository ? { repository } : {}), ...(pullRequest ? { pullRequest } : {}) }
  for (const [commitName, branchName] of buildVariables) {
    const commit = env[commitName]
    if (!commit) continue
    const branch = env[branchName] || (commitName === "GITHUB_SHA" ? env.GITHUB_REF_NAME : undefined)
    return { commit, ...(branch ? { branch } : {}), ...extra }
  }
  const [commit, branch] = await Promise.all([git(root, ["rev-parse", "HEAD"]), git(root, ["rev-parse", "--abbrev-ref", "HEAD"])])
  return { ...(commit ? { commit } : {}), ...(branch && branch !== "HEAD" ? { branch } : {}), ...extra }
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
const version = "1"

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

/** The session reader of the presence rooms: the Console or Auth user, else the person signed in with GitHub. */
async function realtimeSessionLines(options: CommentsVitePluginOptions, imports: CommentsImports, projectRoot: string): Promise<{ imports: string[], value: string }> {
  if (options.auth || options.console) return sessionLines(options, imports)
  const { repository } = await readCommentsBuild(projectRoot)
  return {
    imports: [`import { createCommentsGitHubLogin } from ${JSON.stringify(imports.runtime)}`],
    value: `createCommentsGitHubLogin(${JSON.stringify(repository ? { repository } : {})}).user`,
  }
}

export function renderCommentsHandler(input: { definition: string, content?: string, session: CommentsVitePluginOptions, realtime: boolean, imports: CommentsImports, build?: CommentBuild }): string {
  const session = sessionLines(input.session, input.imports)
  // An app with neither Auth nor the Console gets Sign in with GitHub, which works once the server has an OAuth client.
  const githubLogin = !input.session.auth && !input.session.console
  return [
    `import { createCommentsHandler${githubLogin ? ", createCommentsGitHubLogin" : ""} } from ${JSON.stringify(input.imports.runtime)}`,
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
    ...(githubLogin ? [`  githubLogin: createCommentsGitHubLogin(${JSON.stringify(input.build?.repository ? { repository: input.build.repository } : {})}),`] : []),
    ...(input.content ? ["  content: contentModule.content ? { runtime: contentModule.content, parseField: parseContentField } : undefined,"] : []),
    `  realtime: ${input.realtime},`,
    `  build: ${JSON.stringify(input.build ?? {})},`,
    "  components,",
    "})",
    "",
  ].join("\n")
}

export function renderCommentsPlugin(input: { definition: string, database?: string, imports: CommentsImports, standalone?: StandaloneDatabase }): string {
  if (input.standalone) {
    const { where, fallback, node } = input.standalone
    const options = [`name: "comments"`, "setup: commentsTables", ...(fallback ? [`fallback: ${JSON.stringify(fallback)}`] : [])]
    return [
      `import { defineCommentsPlugin } from ${JSON.stringify(input.imports.runtime)}`,
      // A Worker build imports no node:sqlite.
      `import { connectDatabase } from ${JSON.stringify(node ? `${input.imports.connect}/node` : input.imports.connect)}`,
      `import { commentsTables } from ${JSON.stringify(input.imports.database)}`,
      `import { comments } from ${JSON.stringify(pathToFileURL(input.definition).href)}`,
      "",
      `const database = () => connectDatabase(${where === undefined ? "undefined" : JSON.stringify(where)}, { ${options.join(", ")} })`,
      "",
      `export default defineCommentsPlugin({ comments, database, overlay: ${JSON.stringify(`${overlayBaseURL}/overlay.js?v=${version}`)} })`,
      "",
    ].join("\n")
  }

  return [
    `import { defineCommentsPlugin } from ${JSON.stringify(input.imports.runtime)}`,
    `import { databases } from ${JSON.stringify(input.imports.databases)}`,
    `import { comments } from ${JSON.stringify(pathToFileURL(input.definition).href)}`,
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
    `export default defineCommentsPlugin({ comments, database, overlay: ${JSON.stringify(`${overlayBaseURL}/overlay.js?v=${version}`)} })`,
    "",
  ].join("\n")
}

/** `server/comments.ts` for an app without one: Comments with its defaults. */
async function writeDefaultDefinition(directory: string, imports: CommentsImports): Promise<string> {
  const file = join(directory, "definition.mjs")
  const index = imports.runtime.replace(/\/runtime$/, "")
  await writeFile(file, [
    `import { defineComments } from ${JSON.stringify(index)}`,
    "",
    "// Add `server/comments.ts` to choose who may comment, notify people, or post to pull requests.",
    "export const comments = defineComments()",
    "",
  ].join("\n"))
  return file
}

/**
 * The storage of `comments()`. A build connects to the `database` option, else to what it finds at runtime. The
 * development server uses `.vitehub/data/comments.sqlite`, unless the option is a file, or a variable that is set.
 */
async function standaloneDatabase(projectRoot: string, options: CommentsOptions, command: "build" | "serve"): Promise<StandaloneDatabase> {
  const where = options.database || undefined
  // Fails the build on a location that Comments cannot use.
  parseDatabaseLocation(where, "comments")
  if (where && /[?&]authToken=/.test(where)) console.warn("[vitehub] The token in `comments({ database })` ends up in the build. Use `env:` with a variable instead.")
  if (command !== "serve") return { ...(where ? { where } : {}), node: Boolean(where?.startsWith("file:")) }
  if (where?.startsWith("file:")) return { where, node: true }
  const data = resolve(projectRoot, ".vitehub/data")
  await mkdir(data, { recursive: true })
  // Threads written on this computer stay out of Git.
  await writeFile(join(data, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {})
  const file = `file:${join(data, "comments.sqlite")}`
  // Without a location, the development server keeps threads local instead of writing to the app's database.
  return where?.startsWith("env:") ? { where, fallback: file, node: true } : { where: file, node: true }
}

/**
 * Adds the D1 binding of `database: "d1:NAME"` to the Wrangler config of the build, unless the app's Wrangler file has
 * it. Without an id, `wrangler deploy` creates the database.
 */
async function addD1Binding(projectRoot: string, nitro: Record<string, unknown>, where: string | undefined): Promise<void> {
  if (!where?.startsWith("d1:")) return
  const binding = where.slice(3)
  for (const file of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const source = await readFile(join(projectRoot, file), "utf8").catch(() => "")
    if (new RegExp(`["']?binding["']?\\s*[:=]\\s*["']${binding}["']`).test(source)) return
  }
  const cloudflare: Record<string, unknown> = Object(nitro.cloudflare ?? {})
  const wrangler: Record<string, unknown> = Object(cloudflare.wrangler ?? {})
  const bindings: unknown[] = Array.isArray(wrangler.d1_databases) ? wrangler.d1_databases : []
  if (bindings.some(entry => Object(entry).binding === binding)) return
  nitro.cloudflare = { ...cloudflare, wrangler: { ...wrangler, d1_databases: [...bindings, { binding, database_name: "comments" }] } }
}

/** Whether `vite-hub` is in the app, so it runs Comments and `comments()` steps aside. */
function hasViteHubComments(config: UserConfig): boolean {
  const find = (value: unknown): boolean => Array.isArray(value)
    ? value.some(find)
    : value !== null && typeof value === "object" && Reflect.get(value, "name") === "@vite-hub/comments/vite"
  return find(config.plugins)
}

/**
 * Comments for any Vite app, without `vite-hub`: the comment overlay on every page with `?comments`, threads in a
 * SQLite file, and Sign in with GitHub. It adds Nitro, the server, unless the app has it. With `vite-hub`, it does
 * nothing, because `vitehub()` runs Comments.
 */
export function comments(options: CommentsOptions = {}): PluginOption[] {
  const plugin = hubComments({ standalone: options })
  plugin.apply = config => !hasViteHubComments(config)
  return [plugin, ...includedNitro({ unless: hasViteHubComments })]
}

export default comments

/**
 * Comments build integration. When the app has `server/comments.ts`, it serves the Comments API at
 * `/api/_vitehub/comments/**`, installs the runtime with its Database, adds the tables to that Database, serves the
 * overlay script, and adds it to pages in comment mode. Apps without the file are unaffected.
 */
export function hubComments(options: CommentsVitePluginOptions = {}): CommentsVitePlugin {
  const imports: CommentsImports = { ...defaultImports, ...options.imports }
  let projectRoot: string | undefined
  let serverDirs: string[] | undefined
  let realtime = false
  const discover = () => findCommentsEntry(projectRoot ?? process.cwd(), serverDirs)
  // Without `vite-hub`, Comments is on without `server/comments.ts`.
  const enabled = () => Boolean(options.standalone) || Boolean(discover())

  return {
    name: options.standalone ? "@vite-hub/comments" : "@vite-hub/comments/vite",
    api: {
      async contributeRealtime(context) {
        const definition = findCommentsEntry(context.projectRoot, context.serverDirs)
        if (!definition) return
        realtime = true
        const file = join(context.directory, "comments.mjs")
        const session = await realtimeSessionLines(options, imports, context.projectRoot)
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
                { label: "Comment mode", value: `?${commentsHintQuery} or the ${commentsHintCookie} cookie` },
              ],
              file: relativeDefinitionFile(projectRoot ?? process.cwd(), definition),
              name: "comments",
              source: "server-comments",
            }]
          },
        }],
      }),
      async databases(context) {
        if (options.standalone) return []
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
      async handler(config, env) {
        // SAFETY: Vite passes its user config with ViteHub's shared keys attached.
        const viteConfig = config as UserConfig & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[] }
        projectRoot = viteConfig[VITEHUB_PROJECT_ROOT] ? resolve(viteConfig[VITEHUB_PROJECT_ROOT]) : resolveViteHubProjectRoot(resolve(config.root || process.cwd()))
        serverDirs = viteConfig[VITEHUB_SERVER_DIRS]?.slice()
        const directory = resolve(projectRoot, ".vitehub/nitro/comments")
        if (!enabled()) {
          await rm(directory, { force: true, recursive: true })
          return
        }
        await mkdir(directory, { recursive: true })
        const definition = discover() ?? await writeDefaultDefinition(directory, imports)
        const standalone = options.standalone ? await standaloneDatabase(projectRoot, options.standalone, env.command) : undefined
        const handler = join(directory, "handler.mjs")
        const plugin = join(directory, "plugin.mjs")
        const [build, components] = await Promise.all([readCommentsBuild(projectRoot), readCommentsComponents(projectRoot)])
        await Promise.all([
          writeFile(handler, renderCommentsHandler({ definition, content: findContentEntry(projectRoot, serverDirs), session: options, realtime, imports, build })),
          writeFile(join(directory, "components.mjs"), `export default ${JSON.stringify(components)}\n`),
          writeFile(plugin, renderCommentsPlugin({ definition, database: await readCommentsDatabase(definition), imports, ...(standalone === undefined ? {} : { standalone }) })),
        ])
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        if (standalone) await addD1Binding(projectRoot, kit.config, standalone.where)
        kit.addHandler({ handler, route: `${commentsRoute}/**` })
        kit.addPlugin(plugin)
        const nitro = kit.config
        const assets = Array.isArray(nitro.publicAssets) ? [...nitro.publicAssets] : []
        const overlay = commentsOverlayDirectory()
        if (!assets.some(asset => Object(asset) === asset && Reflect.get(Object(asset), "dir") === overlay)) {
          assets.push({ baseURL: overlayBaseURL, dir: overlay, maxAge: 300 })
        }
        nitro.publicAssets = assets
        Reflect.set(config, "nitro", nitro)
      },
    },
    // A single page app whose `index.html` Vite serves: load the overlay in the browser when the hint is present.
    transformIndexHtml() {
      if (!enabled()) return
      const src = `${overlayBaseURL}/overlay.js?v=${version}`
      return [{
        tag: "script",
        attrs: { type: "module" },
        children: `if(new URLSearchParams(location.search).has(${JSON.stringify(commentsHintQuery)})||document.cookie.split("; ").includes(${JSON.stringify(`${commentsHintCookie}=1`)}))import(${JSON.stringify(src)})`,
        injectTo: "body",
      }]
    },
  }
}
