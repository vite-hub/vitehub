import { execFile } from "node:child_process"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { addViteHubPageToolRoutes } from "@vite-hub/internal/build/page-tools"
import { argumentExpression, objectProperties, scanModule, staticString, unwrapExpression } from "@vite-hub/internal/build/scan-module"
import { resolveViteHubProjectRoot, VITEHUB_APP_BASE_URL, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { relativeDefinitionFile } from "@vite-hub/internal/inspect"
import { includedNitro } from "@vite-hub/internal/build/included-nitro"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { viteHubPageToolsCookie, viteHubPageToolsLoader, viteHubPageToolsPath, viteHubPageToolsQuery } from "@vite-hub/internal/runtime/page-tools-loader"
import { parseDatabaseLocation } from "@vite-hub/database/config"
import { parseJSONC, parseTOML } from "confbox"

import { commentsConsoleSection } from "./console.ts"
import { findCommentsEntry, findContentEntry } from "./entry.ts"
import { commentsRealtimeDefinition, commentsRoute, mountedCommentsRoute } from "./page.ts"

import type { DatabaseContributionContext, DatabaseContributionEntry } from "@vite-hub/database/vite"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin, PluginOption, UserConfig } from "vite"
import type { CommentBuild } from "./types.ts"

export { commentsConsoleSection }
export { mountedCommentsRoute } from "./page.ts"
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
   * use its `comments` section are the people of Comments, and opening the Console turns the page tools on for them.
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
  connect: "@vite-hub/comments/runtime/connect",
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
  const factories = new Set(["defineComments"])
  for (const statement of module.program.body) {
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type" && ["vite-hub/comments", "@vite-hub/comments"].includes(statement.source.value)) {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
        const name = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
        if (name === "defineComments") factories.add(specifier.local.name)
      }
    }
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
      if (call.type !== "CallExpression" || call.callee.type !== "Identifier" || !factories.has(call.callee.name)) continue
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

/** A directory of prebuilt browser scripts in this package. */
function builtDirectory(name: "overlay" | "page"): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // Built: dist/vite.js next to dist/<name>. From source in tests, use the built copy.
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

const version = "1"

/** Generated session reader: the Console user of a request, else the ViteHub Auth user. */
function sessionLines(options: CommentsVitePluginOptions, imports: CommentsImports): { imports: string[], option: "session" | "consoleSession", value: string } {
  if (options.console) {
    return {
      imports: [
        `import { consoleRealtimeAccess } from ${JSON.stringify(options.console.module)}`,
        `import { commentsConsoleSession } from ${JSON.stringify(imports.runtime)}`,
      ],
      option: "consoleSession",
      value: `commentsConsoleSession(consoleRealtimeAccess(${JSON.stringify(commentsConsoleSection.id)}))`,
    }
  }
  return options.auth
    ? { imports: [`import { commentsAuthSession } from ${JSON.stringify(imports.auth)}`], option: "session", value: "commentsAuthSession" }
    : { imports: [], option: "session", value: "undefined" }
}

/** The session reader of presence and MCP: the Console or Auth user, else the person signed in with GitHub. */
function sessionWithGitHubLines(options: CommentsVitePluginOptions, imports: CommentsImports, repository?: string, base?: string): { imports: string[], option: "session" | "consoleSession", value: string, githubLogin?: true } {
  if (options.auth || options.console) return sessionLines(options, imports)
  const route = mountedCommentsRoute(base)
  return {
    imports: [
      `import { createCommentsGitHubLogin } from ${JSON.stringify(imports.runtime)}`,
      `const githubLogin = createCommentsGitHubLogin(${JSON.stringify({ ...(repository ? { repository } : {}), ...(route !== commentsRoute ? { basePath: `${route}/auth` } : {}) })})`,
    ],
    option: "session",
    value: "githubLogin.user",
    githubLogin: true,
  }
}

export function renderCommentsHandler(input: { definition: string, content?: string, session: CommentsVitePluginOptions, realtime: boolean, imports: CommentsImports, build?: CommentBuild, base?: string }): string {
  const session = sessionLines(input.session, input.imports)
  const route = mountedCommentsRoute(input.base)
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
    `  ${session.option}: ${session.value},`,
    ...(githubLogin ? [`  githubLogin: createCommentsGitHubLogin(${JSON.stringify({ ...(input.build?.repository ? { repository: input.build.repository } : {}), ...(route !== commentsRoute ? { basePath: `${route}/auth` } : {}) })}),`] : []),
    ...(input.content ? ["  content: contentModule.content ? { runtime: contentModule.content, parseField: parseContentField } : undefined,"] : []),
    `  realtime: ${input.realtime},`,
    `  build: ${JSON.stringify(input.build ?? {})},`,
    "  components,",
    "})",
    "",
  ].join("\n")
}

export function renderCommentsPlugin(input: { definition: string, database?: string, session?: CommentsVitePluginOptions, imports: CommentsImports, standalone?: StandaloneDatabase, development?: boolean, build?: CommentBuild, base?: string }): string {
  const session = sessionWithGitHubLines(input.session ?? {}, input.imports, input.build?.repository, input.base)
  if (input.standalone) {
    const { where, fallback, node } = input.standalone
    const options = [`name: "comments"`, "setup: commentsTables", ...(fallback ? [`fallback: ${JSON.stringify(fallback)}`] : [])]

    return [
      `import { defineCommentsPlugin } from ${JSON.stringify(input.imports.runtime)}`,
      // A Worker build imports no node:sqlite.
      `import { connectDatabase } from ${JSON.stringify(node ? `${input.imports.connect}/node` : input.imports.connect)}`,
      `import { commentsTables } from ${JSON.stringify(input.imports.database)}`,
      `import { comments } from ${JSON.stringify(pathToFileURL(input.definition).href)}`,
      ...session.imports,
      "",
      `const database = () => connectDatabase(${where === undefined ? "undefined" : JSON.stringify(where)}, { ${options.join(", ")} })`,
      "",
      `export default defineCommentsPlugin({ comments, database, ${session.option}: ${session.value}, ${session.githubLogin ? "githubLogin, " : ""}development: ${input.development === true}, overlay: ${JSON.stringify(`${mountedCommentsRoute(input.base)}/assets/overlay.js?v=${version}`)} })`,
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
    `export default defineCommentsPlugin({ comments, database, ${session.option}: ${session.value}, ${session.githubLogin ? "githubLogin, " : ""}development: ${input.development === true}, overlay: ${JSON.stringify(`${mountedCommentsRoute(input.base)}/assets/overlay.js?v=${version}`)} })`,
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
  const location = parseDatabaseLocation(where, "comments")
  if (where && /[?&]authToken=/.test(where)) console.warn("[vitehub] The token in `comments({ database })` ends up in the build. Use `env:` with a variable instead.")
  if (command !== "serve") return { ...(where ? { where } : {}), node: location.kind === "file" }
  if (location.kind === "file") return { where, node: true }
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
    if (!source) continue
    const config = file.endsWith(".toml") ? parseTOML(source) : parseJSONC(source, { allowTrailingComma: true })
    if (config === null || typeof config !== "object") continue
    const entries: unknown = Reflect.get(config, "d1_databases")
    if (Array.isArray(entries) && entries.some(entry => entry !== null && typeof entry === "object" && Reflect.get(entry, "binding") === binding)) return
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
 * Comments for any Vite app, without `vite-hub`: the comment overlay on every page with `?vitehub`, threads in a
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
  let route = commentsRoute
  let loader = viteHubPageToolsLoader
  let base: string | undefined
  const discover = () => findCommentsEntry(projectRoot ?? process.cwd(), serverDirs)
  // Without `vite-hub`, Comments is on without `server/comments.ts`.
  const enabled = () => Boolean(options.standalone) || Boolean(discover())
  async function writeComponents(): Promise<void> {
    if (!projectRoot || !componentsFile) return
    const components = await readCommentsComponents(projectRoot, 5000, resolvedComponents)
    await writeFile(componentsFile, `export default JSON.parse(${JSON.stringify(JSON.stringify(components))})\n`)
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
        const session = sessionWithGitHubLines(options, imports, repository, base)
        await mkdir(context.directory, { recursive: true })
        await writeFile(file, [
          `import { commentsRealtime } from ${JSON.stringify(imports.realtime)}`,
          `import { comments } from ${JSON.stringify(pathToFileURL(definition).href)}`,
          ...session.imports,
          "",
          `export default commentsRealtime(comments, { ${session.option}: ${session.value} })`,
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
                { label: "Route", value: `${route}/**` },
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
        const viteConfig = config as UserConfig & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[], [VITEHUB_APP_BASE_URL]?: string }
        base = viteConfig[VITEHUB_APP_BASE_URL] ?? config.base
        route = mountedCommentsRoute(base)
        loader = viteHubPageToolsPath(viteHubPageToolsLoader, base)
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
        const standalone = options.standalone ? await standaloneDatabase(projectRoot, options.standalone, env.command) : undefined
        const handler = join(directory, "handler.mjs")
        const plugin = join(directory, "plugin.mjs")
        const pageSession = join(directory, "page-session.mjs")
        componentsFile = join(directory, "components.mjs")
        const build = await readCommentsBuild(projectRoot)
        const pluginInput = { definition, database: await readCommentsDatabase(definition), session: options, imports, build, base, development: env.command === "serve" && !env.isPreview, ...(standalone === undefined ? {} : { standalone }) }
        await Promise.all([
          writeFile(handler, renderCommentsHandler({ definition, content: findContentEntry(projectRoot, serverDirs), session: options, realtime, imports, build, base })),
          writeComponents(),
          writeFile(plugin, renderCommentsPlugin(pluginInput)),
          writeFile(pageSession, `export { viteHubPageSessionHandler as default } from ${JSON.stringify(imports.runtime)}\n`),
        ])
        const kit = createNitroServerKit(Reflect.get(config, "nitro"))
        if (standalone) await addD1Binding(projectRoot, kit.config, standalone.where)
        if (standalone && env.command === "build") {
          const modules = Array.isArray(kit.config.modules) ? [...kit.config.modules] : []
          // Nitro resolves the preset and its Node support after Vite config hooks. Runtime variables may name files.
          modules.push(async (nitro: { options: { node: boolean } }) => {
            parseDatabaseLocation(standalone.where, "comments", { node: nitro.options.node })
            await writeFile(plugin, renderCommentsPlugin({ ...pluginInput, standalone: { ...standalone, node: nitro.options.node } }))
          })
          kit.config.modules = modules
        }
        kit.addHandler({ handler, route: `${route}/**` })
        kit.addPlugin(plugin)
        addViteHubPageToolRoutes(kit, { handler: pageSession, loader: builtDirectory("page"), base })
        const nitro = kit.config
        const assets = Array.isArray(nitro.publicAssets) ? [...nitro.publicAssets] : []
        const overlay = commentsOverlayDirectory()
        if (!assets.some(asset => Object(asset) === asset && Reflect.get(Object(asset), "dir") === overlay)) {
          assets.push({ baseURL: `${route}/assets`, dir: overlay, maxAge: 300 })
        }
        nitro.publicAssets = assets
        Reflect.set(config, "nitro", nitro)
      },
    },
    // A single page app whose `index.html` Vite serves: load the page tools in the browser when the hint is present.
    transformIndexHtml() {
      if (!enabled()) return
      return [{
        tag: "script",
        attrs: { type: "module" },
        children: `if(new URLSearchParams(location.search).has(${JSON.stringify(viteHubPageToolsQuery)})||document.cookie.split("; ").includes(${JSON.stringify(`${viteHubPageToolsCookie}=1`)}))import(${JSON.stringify(loader)})`,
        injectTo: "body",
      }]
    },
  }
}
