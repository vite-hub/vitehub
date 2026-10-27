import { execFile } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { argumentExpression, objectProperties, scanModule, staticString, unwrapExpression } from "@vite-hub/internal/build/scan-module"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { includedNitro } from "@vite-hub/internal/build/included-nitro"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

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
  /** Exports `openCommentsSqlite`. */
  sqlite: string
}

/** Options of `comments()`, for apps that use Comments without `vite-hub`. */
export interface CommentsOptions {
  /**
   * The SQLite file that stores threads, such as `file:./data/comments.sqlite`, relative to the server's working
   * directory. Comments opens it with Node's built-in `node:sqlite` and creates its tables. The development server
   * defaults to `.vitehub/data/comments.sqlite`; a production build needs it, because only you know which disk lasts.
   */
  database?: string
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

/** The names and source files resolved by Nuxt's component scanner. */
export interface CommentsComponent {
  pascalName: string
  filePath: string
}

export type CommentsVitePlugin = Plugin & {
  api: {
    /** Supplies Nuxt's effective component names, and refreshes the generated map after a rescan. */
    setComponents(components: readonly CommentsComponent[]): Promise<void>
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
  sqlite: "@vite-hub/comments/runtime/sqlite",
}

/**
 * The Database name in `defineComments({ database: "name" })`, read without running the file. Undefined means the
 * default or only Database.
 */
export async function readCommentsDatabase(file: string): Promise<string | undefined> {
  const source = await readFile(file, "utf8").catch(() => "")
  const module = scanModule(source, file)
  if (module.errors.length) return
  const bindings = new Set<string>()
  for (const statement of module.program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.source) continue
    if (statement.declaration?.type === "VariableDeclaration") {
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type === "Identifier" && declaration.id.name === "comments") bindings.add(declaration.id.name)
      }
    }
    for (const specifier of statement.specifiers) {
      const name = specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value
      if (name === "comments" && specifier.local.type === "Identifier") bindings.add(specifier.local.name)
    }
  }
  for (const statement of module.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type !== "VariableDeclaration") continue
    for (const binding of declaration.declarations) {
      if (binding.id.type !== "Identifier" || !bindings.has(binding.id.name) || !binding.init) continue
      const call = unwrapExpression(binding.init)
      if (call.type !== "CallExpression" || call.callee.type !== "Identifier" || call.callee.name !== "defineComments") continue
      const options = argumentExpression(call.arguments[0])
      if (options?.type !== "ObjectExpression") return
      for (const property of objectProperties(options).reverse()) {
        // A later spread or dynamic key may replace an earlier Database option.
        if (property.key === undefined) return
        if (property.key !== "database") continue
        if (property.node.type !== "Property" || property.node.kind !== "init" || property.node.method) return
        return staticString(property.value)
      }
      return
    }
  }
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

/** `owner/name` of a GitHub or Enterprise remote. The forge's API URL selects the server at runtime. */
export function githubRepository(remote: string | undefined): string | undefined {
  return remote ? /^(?:(?:https?|ssh|git):\/\/[^/]+\/|(?:[^@/:]+@)?[\w.-]+:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())?.[1] : undefined
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

/**
 * The names that a production build may give the component of a `.vue` file: its file name, which `<script setup>`
 * uses; under `pages/`, the Nuxt route name, such as `blog-id` for `pages/blog/[id].vue`.
 * Nuxt component names come from its resolved registry rather than a path heuristic.
 */
export function componentNames(file: string): string[] {
  const names = new Set([basename(file, ".vue")])
  const parts = file.replace(/\.vue$/, "").split("/")
  const pages = parts.lastIndexOf("pages")
  if (pages !== -1) {
    const route = parts.slice(pages + 1).filter(part => part !== "index" && !/^\(.*\)$/.test(part)).map(part => part.replace(/[[\].]/g, "")).join("-")
    names.add(route || "index")
  }
  return [...names]
}

/**
 * The Vue files of a project by component name, relative to the project root. `<script setup>` components carry the
 * name of their file in production builds, so the name finds the file. It skips dot directories and build output.
 */
export async function readCommentsComponents(root: string, limit = 5000, resolvedComponents: readonly CommentsComponent[] = []): Promise<Record<string, string[]>> {
  const components: Record<string, string[]> = Object.create(null)
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
  const resolvedNames: Record<string, string[]> = Object.create(null)
  for (const component of resolvedComponents) {
    const file = relative(root, component.filePath).split(sep).join("/")
    // Nuxt's registry also includes library components and generated placeholders, which are not project sources.
    if (!file.endsWith(".vue") || file.split("/").some(part => part !== ".." && (part.startsWith(".") || skippedDirectories.has(part)))) continue
    const files = resolvedNames[component.pascalName] ??= []
    if (!files.includes(file)) files.push(file)
  }
  // A resolved name wins over ambiguous filename fallbacks.
  Object.assign(components, resolvedNames)
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

/** The session reader of presence and MCP: the Console or Auth user, else the person signed in with GitHub. */
function sessionWithGitHubLines(options: CommentsVitePluginOptions, imports: CommentsImports, repository?: string): { imports: string[], value: string } {
  if (options.auth || options.console) return sessionLines(options, imports)
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

/** What a production build without a database tells the server log. */
const missingSqlite = "[vitehub] Comments has no database in this build. Set `comments({ database: \"file:./data/comments.sqlite\" })` to a file on a disk that lasts, or use `vite-hub` with a Database."

export function renderCommentsPlugin(input: { definition: string, database?: string, session?: CommentsVitePluginOptions, imports: CommentsImports, sqlite?: string | false, development?: boolean, build?: CommentBuild }): string {
  const session = sessionWithGitHubLines(input.session ?? {}, input.imports, input.build?.repository)
  if (input.sqlite !== undefined) {
    return [
      `import { defineCommentsPlugin } from ${JSON.stringify(input.imports.runtime)}`,
      ...(input.sqlite ? [`import { openCommentsSqlite } from ${JSON.stringify(input.imports.sqlite)}`] : []),
      `import { comments } from ${JSON.stringify(pathToFileURL(input.definition).href)}`,
      ...session.imports,
      "",
      input.sqlite
        ? `const database = () => openCommentsSqlite(${JSON.stringify(input.sqlite)})`
        : "const database = () => undefined",
      "",
      `export default defineCommentsPlugin({ comments, database, session: ${session.value}, development: ${input.development === true}, overlay: ${JSON.stringify(`${overlayBaseURL}/overlay.js?v=${version}`)}, missingDatabase: ${JSON.stringify(missingSqlite)} })`,
      "",
    ].join("\n")
  }
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
    `export default defineCommentsPlugin({ comments, database, session: ${session.value}, development: ${input.development === true}, overlay: ${JSON.stringify(`${overlayBaseURL}/overlay.js?v=${version}`)} })`,
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
 * The SQLite file of `comments()`: the `database` option, else `.vitehub/data/comments.sqlite` on the development
 * server. A production build without the option has none (`false`), so the server says so instead of losing threads.
 */
async function standaloneDatabase(projectRoot: string, options: CommentsOptions, command: "build" | "serve"): Promise<string | false> {
  if (options.database) return options.database
  if (command !== "serve") return false
  const data = resolve(projectRoot, ".vitehub/data")
  await mkdir(data, { recursive: true })
  // Threads written on this computer stay out of Git.
  await writeFile(join(data, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {})
  return `file:${join(data, "comments.sqlite")}`
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
  let resolvedComponents: readonly CommentsComponent[] = []
  let componentsFile: string | undefined
  const discover = () => findCommentsEntry(projectRoot ?? process.cwd(), serverDirs)
  // Without `vite-hub`, Comments is on without `server/comments.ts`.
  const enabled = () => Boolean(options.standalone) || Boolean(discover())
  async function writeComponents(): Promise<void> {
    if (!projectRoot || !componentsFile) return
    const components = await readCommentsComponents(projectRoot, 5000, resolvedComponents)
    await writeFile(componentsFile, `export default ${JSON.stringify(components)}\n`)
  }

  return {
    name: options.standalone ? "@vite-hub/comments" : "@vite-hub/comments/vite",
    api: {
      async setComponents(components) {
        resolvedComponents = components
        await writeComponents()
      },
      async contributeRealtime(context) {
        const definition = findCommentsEntry(context.projectRoot, context.serverDirs)
        if (!definition) return
        realtime = true
        const file = join(context.directory, "comments.mjs")
        const { repository } = await readCommentsBuild(context.projectRoot)
        const session = sessionWithGitHubLines(options, imports, repository)
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
          componentsFile = undefined
          await rm(directory, { force: true, recursive: true })
          return
        }
        await mkdir(directory, { recursive: true })
        const definition = discover() ?? await writeDefaultDefinition(directory, imports)
        const sqlite = options.standalone ? await standaloneDatabase(projectRoot, options.standalone, env.command) : undefined
        const handler = join(directory, "handler.mjs")
        const plugin = join(directory, "plugin.mjs")
        componentsFile = join(directory, "components.mjs")
        const build = await readCommentsBuild(projectRoot)
        await Promise.all([
          writeFile(handler, renderCommentsHandler({ definition, content: findContentEntry(projectRoot, serverDirs), session: options, realtime, imports, build })),
          writeComponents(),
          writeFile(plugin, renderCommentsPlugin({ definition, database: await readCommentsDatabase(definition), session: options, imports, build, development: env.command === "serve" && !env.isPreview, ...(sqlite === undefined ? {} : { sqlite }) })),
        ])
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
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
