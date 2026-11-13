import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  resolveViteHubProjectRoot,
  VITEHUB_APP_BASE_URL,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_PROJECT_ROOT,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"
import { exportNames } from "@vite-hub/internal/build/scan-module"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import type { Plugin, UserConfig } from "vite"
import { installContentTypesWriter } from "./internal/content-types-writer.ts"
import { inspectCollectionDefinitions } from "./inspect.ts"
import { BUNDLED_GLOB_ID_PATTERN, findGlobCalls, loadBundledGlob, rewriteGlobCalls } from "./internal/bundle-glob.ts"
import { collectCollectionFiles, discoverCollections, inspectCollectionSource } from "./internal/collection-discovery.ts"
import type { DiscoveredCollection } from "./internal/collection-discovery.ts"
import { collectionRoutePath } from "./internal/collection-route.ts"
import { sourceErrorDiagnostics } from "./error-diagnostics.ts"

export { inspectCollectionDefinitions, type CollectionInspectionOptions } from "./inspect.ts"

const collectionTypesEntry = ".vitehub/types/source/collections.d.ts"
// Earlier versions wrote this wrapper around `collections.d.ts`. Generation removes it, so an upgraded app with no
// Collection does not keep a declaration that points at a deleted file.
const retiredCollectionTypesWrapper = ".vitehub/types/source/vitehub-source-registry.d.ts"
const collectionRoutesDirectory = ".vitehub/source/routes"
const contentRouteEntry = ".vitehub/content/route.mjs"
const contentPreviewEntry = ".vitehub/content/preview.mjs"
const contentSitemapEntry = ".vitehub/content/sitemap.mjs"
const contentRobotsEntry = ".vitehub/content/robots.mjs"
const contentMarkdownEntry = ".vitehub/content/markdown.mjs"
const contentRssEntry = ".vitehub/content/rss.mjs"
const contentMcpEntry = ".vitehub/content/mcp.mjs"
const contentLlmsEntry = ".vitehub/content/llms.mjs"
const contentSqliteEntry = ".vitehub/content/sqlite.mjs"
const contentGitHubWebhookEntry = ".vitehub/content/github-webhook.mjs"
const contentPreviewRoutesEntry = ".vitehub/content/preview-routes.mjs"
const contentTypesPluginEntry = ".vitehub/content/types.mjs"
// The Content types plugin writes this file in development. `.vitehub/types.d.ts` references every file in `.vitehub/types`.
const contentTypesEntry = ".vitehub/types/content.d.ts"
// Auth owns this virtual module. Generated routes import it only when Auth is enabled.
const authServerModuleId = "#vitehub/auth/server"
const initialHostRefreshRetryDelay = 25
const maximumHostRefreshRetryDelay = 1_000
const hostRestartOwnerSettlementTimeout = 30_000

/** A file ViteHub generates for Nitro: a route handler, or a Nitro plugin such as the Content preview scope. */
export type GeneratedSourceHandler = GeneratedSourceRoute | GeneratedSourcePlugin

export interface GeneratedSourceRoute {
  handler: string
  method?: "get" | "post"
  /** Runs for every request and passes through when it does not answer, as Content's `<url>.md` copies do. */
  middleware?: true
  /**
   * `false` loads the handler when the server starts. Middleware that reads the response of later handlers needs it,
   * because a lazy handler does not receive `next`. Such a handler must load heavy modules itself, on demand.
   */
  lazy?: false
  plugin?: never
  route: string
}

/** A generated Nitro plugin. It registers no route, so it never conflicts with one. */
export interface GeneratedSourcePlugin {
  handler: string
  method?: never
  plugin: true
  /** Install request interception before an async plugin can let the server accept requests. */
  position?: "start" | "end"
  route?: never
}

export interface SourceGenerationOptions {
  /** Pass Auth's `withAuthorization` to generated Collection routes. Requires the Auth Vite plugin. */
  auth?: boolean
  contentImportBase?: string
  importBase?: string
  projectRoot: string
  serverDirs?: string[]
}

export interface SourceVitePluginOptions {
  /** Pass Auth's `withAuthorization` to generated Collection routes when the Auth Vite plugin has a Definition. */
  auth?: boolean | ((input: { projectRoot: string, serverDirs?: string[] }) => boolean)
  contentImportBase?: string
  importBase?: string
}

/** The discovered `server/content.ts` file. Its default export is the Content runtime. */
export interface ContentDefinitionFile {
  handler: string
}

export type GeneratedSourceHandlersListener = (handlers: GeneratedSourceHandler[]) => Promise<void> | void

export interface GeneratedSourceHandlersListenerOptions {
  handlesHostRestart?: boolean
  projectRoot?: string
}

interface NitroGeneratedConfig {
  handlers?: Array<{ handler: string, method?: string, middleware?: boolean, route?: string }>
  modules?: unknown[]
  plugins?: unknown[]
}

interface SourceNitroHost extends NitroRouteGuard {
  options: NitroGeneratedConfig & NonNullable<NitroRouteGuard["options"]>
  routing: { sync(): void }
}

interface NitroRouteGuard {
  options?: { dev?: boolean, runtimeConfig?: Record<string, unknown> }
  hooks: { hook(name: "build:before" | "close", callback: () => void | Promise<void>): void }
  scannedHandlers: Array<{ method?: string, middleware?: boolean, route?: string }>
}

interface SourcePluginConfig {
  base?: string
  define?: Record<string, string>
  nitro?: unknown
  root?: string
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
  [VITEHUB_PROJECT_ROOT]?: string
  [VITEHUB_SERVER_DIRS]?: string[]
}

interface GeneratedSourceArtifactsSnapshot {
  files: Map<string, string>
}

async function snapshotDirectoryFiles(directory: string, files: Map<string, string>): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await snapshotDirectoryFiles(path, files)
    else if (entry.isFile()) files.set(path, await readFile(path, "utf8"))
  }
}

async function snapshotGeneratedSourceArtifacts(projectRoot: string): Promise<GeneratedSourceArtifactsSnapshot> {
  const files = new Map<string, string>()
  const fixedEntries = [
    collectionTypesEntry,
    contentRouteEntry,
    contentPreviewEntry,
    contentSitemapEntry,
    contentRobotsEntry,
    contentMarkdownEntry,
    contentRssEntry,
    contentLlmsEntry,
    contentSqliteEntry,
    contentTypesPluginEntry,
    contentTypesEntry,
  ]
  for (const entry of fixedEntries) {
    const path = resolve(projectRoot, entry)
    try {
      files.set(path, await readFile(path, "utf8"))
    }
    catch (error) {
      if (!(error instanceof Error && Reflect.get(error, "code") === "ENOENT")) throw error
    }
  }
  const routesDirectory = resolve(projectRoot, collectionRoutesDirectory)
  try {
    await snapshotDirectoryFiles(routesDirectory, files)
  }
  catch (error) {
    if (!(error instanceof Error && Reflect.get(error, "code") === "ENOENT")) throw error
  }
  return { files }
}

async function restoreGeneratedSourceArtifacts(
  projectRoot: string,
  snapshot: GeneratedSourceArtifactsSnapshot,
): Promise<void> {
  const routesDirectory = resolve(projectRoot, collectionRoutesDirectory)
  await rm(routesDirectory, { force: true, recursive: true })
  for (const entry of [
    collectionTypesEntry,
    contentRouteEntry,
    contentPreviewEntry,
    contentSitemapEntry,
    contentRobotsEntry,
    contentMarkdownEntry,
    contentRssEntry,
    contentLlmsEntry,
    contentSqliteEntry,
    contentTypesPluginEntry,
    contentTypesEntry,
  ]) {
    const path = resolve(projectRoot, entry)
    if (!snapshot.files.has(path)) await rm(path, { force: true })
  }
  for (const [path, contents] of snapshot.files) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
}

function methodsOverlap(left: string | undefined, right: string | undefined): boolean {
  return !left || !right || left.toLowerCase() === right.toLowerCase()
}

function generatedRouteOwner(handler: GeneratedSourceRoute): "Collection" | "Content" {
  return handler.middleware || handler.route === "/api/content/**" || handler.route === "/_vitehub/content/github" || handler.route === "/sitemap.xml" || handler.route === "/robots.txt" || handler.route === "/rss.xml" || handler.route === "/mcp" ? "Content" : "Collection"
}

function generatedRouteDescription(handler: GeneratedSourceRoute): string {
  return handler.method ? `${handler.method.toUpperCase()} handler` : "handler"
}

function assertGeneratedRoutes(nitro: NitroRouteGuard, generatedHandlers: GeneratedSourceHandler[]): void {
  for (const generatedHandler of generatedHandlers) {
    if (generatedHandler.plugin || generatedHandler.middleware) continue
    const duplicate = nitro.scannedHandlers.some(candidate =>
      !candidate.middleware
      && candidate.route === generatedHandler.route
      && methodsOverlap(candidate.method, generatedHandler.method))
    if (duplicate) {
      throw sourceErrorDiagnostics.SOURCE_B0001({ message: `[vitehub] Generated ${generatedRouteOwner(generatedHandler)} route ${JSON.stringify(generatedHandler.route)} conflicts with an existing ${generatedRouteDescription(generatedHandler)}. Remove the matching server route.` })
    }
  }
}

function generatedRouteGuard(generatedHandlers: GeneratedSourceHandler[]) {
  return {
    name: "vite-hub/generated-route-guard",
    async setup(nitro: NitroRouteGuard) {
      nitro.hooks.hook("build:before", () => assertGeneratedRoutes(nitro, generatedHandlers))
      const typesPlugin = generatedHandlers.find(handler => handler.plugin && handler.handler.replaceAll("\\", "/").endsWith(`/${contentTypesPluginEntry}`))
      if (typesPlugin) await installContentTypesWriter(nitro, typesPlugin.handler)
    },
  }
}

export function mergeGeneratedSourceNitroConfig(
  value: unknown,
  generatedHandlers: GeneratedSourceHandler[],
): NitroGeneratedConfig {
  const nitro: NitroGeneratedConfig = {}
  if (Object(value) === value && !Array.isArray(value)) Object.assign(nitro, value)
  if (generatedHandlers.length === 0) return nitro
  const kit = createNitroServerKit(nitro)
  // SAFETY: The kit materializes Nitro handler entries as the generated route shape, plus Nitro's middleware flag.
  const handlers = kit.config.handlers as Array<GeneratedSourceRoute & { middleware?: boolean }>

  for (const handler of generatedHandlers) {
    if (handler.plugin) {
      kit.addPlugin(handler.handler, handler.position)
      continue
    }
    const exact = handlers.some(candidate =>
      candidate.handler === handler.handler
      && candidate.route === handler.route
      && candidate.method?.toLowerCase() === handler.method?.toLowerCase())
    if (exact) continue
    const duplicate = !handler.middleware && handlers.some(candidate =>
      !candidate.middleware && candidate.route === handler.route && methodsOverlap(candidate.method, handler.method))
    if (duplicate) {
      throw sourceErrorDiagnostics.SOURCE_B0002({ message: `[vitehub] Generated ${generatedRouteOwner(handler)} route ${JSON.stringify(handler.route)} conflicts with an existing ${generatedRouteDescription(handler)}. Remove the matching server route.` })
    }
    // Content routes import the Markdown parser and the Sources. Loaded on their first request, they stay out of the
    // server's start.
    kit.addHandler({ ...handler, lazy: handler.lazy ?? true })
  }

  const modules = Array.isArray(nitro.modules) ? [...nitro.modules] : []
  if (!modules.some(module =>
    Object(module) === module && Reflect.get(Object(module), "name") === "vite-hub/generated-route-guard")) {
    modules.push(generatedRouteGuard(generatedHandlers))
  }
  kit.config.modules = modules
  // SAFETY: The kit preserves the Nitro config object shape while adding generated route modules.
  return kit.config as NitroGeneratedConfig
}

export function toRuntimeModuleSpecifier(file: string): string {
  return pathToFileURL(file, { windows: /^[A-Z]:[\\/]/i.test(file) }).href
}

export function toTypeModuleSpecifier(file: string): string {
  return file.replaceAll("\\", "/")
}

/** Inspects the named Collection export without running application code. The docs snippet check calls it. */
export function inspectCollectionModule(file: string, source: string, exportName: string): { exported: boolean, routeEnabled: boolean } {
  return inspectCollectionSource(file, source, exportName)
}

async function writeFileIfChanged(path: string, contents: string): Promise<void> {
  let current: string | undefined
  try {
    current = await readFile(path, "utf8")
  }
  catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error
  }
  if (current === contents) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, "utf8")
}

async function writeCollectionArtifacts(
  options: SourceGenerationOptions,
  collections: DiscoveredCollection[],
): Promise<GeneratedSourceHandler[]> {
  const output = resolve(options.projectRoot, collectionTypesEntry)
  const routesDirectory = resolve(options.projectRoot, collectionRoutesDirectory)
  await rm(resolve(options.projectRoot, retiredCollectionTypesWrapper), { force: true })
  if (collections.length === 0) {
    await Promise.all([
      rm(output, { force: true }),
      rm(routesDirectory, { force: true, recursive: true }),
    ])
    return []
  }

  const routedCollections = collections.filter(collection => collection.route)
  await writeFileIfChanged(output, [
    "declare global {",
    "  interface ViteHubCollectionMap {",
    ...routedCollections.map(({ exportName, file, name }) =>
      `    ${JSON.stringify(name)}: typeof import(${JSON.stringify(toTypeModuleSpecifier(file))})[${JSON.stringify(exportName)}]`),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n"))

  const expectedRoutes = new Set(routedCollections.map(({ name }) => resolve(routesDirectory, `${name}.mjs`)))
  const existingRoutes = await collectCollectionFiles(routesDirectory)
  await Promise.all(existingRoutes.filter(file => !expectedRoutes.has(file)).map(file => rm(file, { force: true })))
  return await Promise.all(routedCollections.map(async ({ exportName, file, name }) => {
    const handler = resolve(routesDirectory, `${name}.mjs`)
    await writeFileIfChanged(handler, [
      `import { defineCollectionHandler } from ${JSON.stringify(`${options.importBase ?? "@vite-hub/source"}/server`)}`,
      ...(options.auth ? [`import { withAuthorization } from ${JSON.stringify(authServerModuleId)}`] : []),
      `import { ${exportName} as collection } from ${JSON.stringify(toRuntimeModuleSpecifier(file))}`,
      "",
      options.auth
        ? "export default defineCollectionHandler(collection, { withAuthorization })"
        : "export default defineCollectionHandler(collection)",
      "",
    ].join("\n"))
    return {
      handler,
      method: "get" as const,
      route: collectionRoutePath(name),
    }
  }))
}

/**
 * Find the `server/content.{ts,js}` file whose default export is the application Content runtime. Returns undefined when
 * the project has none. The generated `/api/content/**` route and the Console content editor import the same file.
 */
export async function findContentEntry(options: Pick<SourceGenerationOptions, "projectRoot" | "serverDirs">): Promise<string | undefined> {
  const serverDirs = options.serverDirs === undefined
    ? [resolve(options.projectRoot, "server")]
    : options.serverDirs.map(directory => resolve(options.projectRoot, directory))
  const candidates: string[] = []
  for (const serverDir of serverDirs) {
    let entries
    try {
      entries = await readdir(serverDir, { withFileTypes: true })
    }
    catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") continue
      throw error
    }
    candidates.push(...entries
      .filter(entry => entry.isFile() && /^content\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name))
      .map(entry => join(serverDir, entry.name)))
  }
  candidates.sort()
  if (candidates.length > 1) throw sourceErrorDiagnostics.SOURCE_B0007({ message: "[vitehub] Content is defined in more than one server directory." })
  const file = candidates[0]
  if (!file) return
  const exports = exportNames(await readFile(file, "utf8"), file)
  if (!exports.includes("default")) {
    const name = JSON.stringify(relative(options.projectRoot, file))
    // A named `content` export was the form before the default export.
    if (exports.includes("content")) {
      throw sourceErrorDiagnostics.SOURCE_B0009({ message: `[vitehub] Content file ${name} exports \`content\` by name. Content is now the default export: \`export default defineContent({ ... })\`.` })
    }
    throw sourceErrorDiagnostics.SOURCE_B0008({ message: `[vitehub] Content file ${name} must default-export the result of defineContent(): \`export default defineContent({ ... })\`.` })
  }
  return file
}

/** What a Content module's `defineContent()` call may define, as far as reading the file without running it can tell. */
export interface ContentEntryFeatures {
  /** Public HTTP route. True unless `route` is literally false. */
  route: boolean
  /** Editable `collections`. True when discovery cannot follow the options. */
  collections: boolean
  /** `seo: { sitemap }` that is not literally false. */
  sitemap: boolean
  /** `seo: { robots }` that is not literally false. */
  robots: boolean
  /** `seo: { markdown }` that is not literally false, or `seo: { llms }` on, whose links need the Markdown copies. */
  markdown: boolean
  /** `seo: { rss }` that is not literally false. */
  rss: boolean
  /** Whether `seo.mcp` is enabled, or unknown when discovery cannot follow its value. */
  mcp: boolean | "unknown"
  /** `seo: { llms }` that is not literally false. */
  llms: boolean
  /** `live` that is not literally false: Content edits Markdown documents live where Realtime has a room authority. */
  live: boolean
  /** `previews` that is set and not literally false: Content serves refs of its `github()` Source at `/tree`, `/blob`, and `/pr` URLs. */
  previews: boolean
  /** The module imports `sqlite` from `vite-hub/content/sqlite`, so SQLite WASM must load when a Worker starts. */
  sqlite: boolean
  /** The module imports `github` from `vite-hub/source`, so a push webhook route can move the head of its Sources. */
  github: boolean
}

type AstNode = Record<string, unknown> & { type?: unknown }

const contentModules: ReadonlySet<string> = new Set(["vite-hub/content", "@vite-hub/content"])

function isAstNode(value: unknown): value is AstNode {
  return value !== null && Object(value) === value && !Array.isArray(value)
}

function astNodes(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.filter(isAstNode) : []
}

function astName(node: unknown): string | undefined {
  if (!isAstNode(node)) return
  if (node.type === "Identifier" && String(node.name) === node.name) return node.name
  if (node.type === "Literal" && String(node.value) === node.value) return node.value
}

/** Drops `as`, `satisfies`, `!`, and parentheses around an expression. */
function unwrapAst(node: unknown): unknown {
  let current = node
  while (isAstNode(current) && ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(String(current.type))) {
    current = current.expression
  }
  return current
}

/**
 * Read the `defineContent()` call that the default export holds. Collections count as present unless the call
 * provably has no non-empty `collections` object. SEO routes count only when the call has a `seo` option: a literal
 * `sitemap`, `robots`, `markdown`, `rss`, `mcp`, or `llms` that is not `false`, or a `seo` value that discovery cannot follow.
 */
export function inspectContentModule(program: unknown, contentImportBase?: string): ContentEntryFeatures {
  return { ...inspectContentOptions(program, contentImportBase), sqlite: importsContentSqlite(program, contentImportBase), github: importsGitHubSource(program) }
}

const sourceModules: ReadonlySet<string> = new Set(["vite-hub/source", "@vite-hub/source"])

function importsGitHubSource(program: unknown): boolean {
  return (isAstNode(program) ? astNodes(program.body) : []).some(statement => statement.type === "ImportDeclaration"
    && isAstNode(statement.source) && sourceModules.has(String(statement.source.value))
    && astNodes(statement.specifiers).some(specifier => specifier.type === "ImportSpecifier" && astName(specifier.imported) === "github"))
}

function importsContentSqlite(program: unknown, contentImportBase?: string): boolean {
  const bases = contentImportBase ? new Set([...contentModules, contentImportBase]) : contentModules
  const modules = new Set([...bases].map(base => `${base}/sqlite`))
  return (isAstNode(program) ? astNodes(program.body) : [])
    .some(statement => statement.type === "ImportDeclaration" && isAstNode(statement.source) && modules.has(String(statement.source.value)))
}

function inspectContentOptions(program: unknown, contentImportBase?: string): Omit<ContentEntryFeatures, "github" | "sqlite"> {
  const maybe: Omit<ContentEntryFeatures, "github" | "sqlite"> = { route: true, collections: true, sitemap: false, robots: false, markdown: false, rss: false, mcp: false, llms: false, live: true, previews: false }
  const body = isAstNode(program) ? astNodes(program.body) : []
  const constants = new Map<string, unknown>()
  const defineContentNames = new Set<string>()
  const defineContentNamespaces = new Set<string>()
  const modules = contentImportBase ? new Set([...contentModules, contentImportBase]) : contentModules
  let contentInit: unknown
  let contentLocal: string | undefined
  for (const statement of body) {
    if (statement.type === "ImportDeclaration" && isAstNode(statement.source) && modules.has(String(statement.source.value))) {
      for (const specifier of astNodes(statement.specifiers)) {
        if (specifier.type === "ImportSpecifier" && astName(specifier.imported) === "defineContent") {
          const local = astName(specifier.local)
          if (local) defineContentNames.add(local)
        }
        if (specifier.type === "ImportNamespaceSpecifier") {
          const local = astName(specifier.local)
          if (local) defineContentNamespaces.add(local)
        }
      }
    }
    const exported = statement.type === "ExportNamedDeclaration"
    const declaration = exported ? statement.declaration : statement
    if (isAstNode(declaration) && declaration.type === "VariableDeclaration") {
      for (const declarator of astNodes(declaration.declarations)) {
        const local = astName(declarator.id)
        if (local && declaration.kind === "const") constants.set(local, declarator.init)
      }
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const value = unwrapAst(statement.declaration)
      if (isAstNode(value) && value.type === "Identifier") contentLocal = astName(value)
      else contentInit = statement.declaration
    }
    if (exported && !statement.source) {
      for (const specifier of astNodes(statement.specifiers)) {
        if (astName(specifier.exported) === "default") contentLocal = astName(specifier.local)
      }
    }
  }
  if (contentInit === undefined && contentLocal) contentInit = constants.get(contentLocal)
  const resolveNode = (node: unknown): unknown => {
    const value = unwrapAst(node)
    const local = isAstNode(value) && value.type === "Identifier" ? astName(value) : undefined
    return local && constants.has(local) ? unwrapAst(constants.get(local)) : value
  }
  const properties = (node: unknown): Map<string, unknown> | undefined => {
    if (!isAstNode(node) || node.type !== "ObjectExpression") return
    const result = new Map<string, unknown>()
    for (const property of Array.isArray(node.properties) ? node.properties : []) {
      if (!isAstNode(property)) return
      if (property.type === "SpreadElement") {
        const spread = properties(resolveNode(property.argument))
        if (!spread) return
        for (const [key, value] of spread) result.set(key, value)
        continue
      }
      if (property.type !== "Property" || property.computed) return
      const key = astName(property.key)
      if (key) result.set(key, property.value)
    }
    return result
  }

  const call = unwrapAst(contentInit)
  if (!isAstNode(call) || call.type !== "CallExpression") return maybe
  const calleeNode = unwrapAst(call.callee)
  const callee = astName(calleeNode)
  const namespaceCall = isAstNode(calleeNode)
    && calleeNode.type === "MemberExpression"
    && !calleeNode.computed
    && defineContentNamespaces.has(astName(calleeNode.object) ?? "")
    && astName(calleeNode.property) === "defineContent"
  if ((!callee || !defineContentNames.has(callee)) && !namespaceCall) return maybe
  const [argument, ...rest] = Array.isArray(call.arguments) ? call.arguments : []
  if (argument === undefined) return { route: true, collections: false, sitemap: false, robots: false, markdown: false, rss: false, mcp: false, llms: false, live: true, previews: false }
  const options = rest.length ? undefined : properties(resolveNode(argument))
  // Unknown option shapes may still enable SEO at runtime (for example via a spread).
  // Keep generated handlers enabled rather than silently omitting valid routes.
  if (!options) return { route: true, collections: true, sitemap: true, robots: true, markdown: true, rss: true, mcp: "unknown", llms: true, live: true, previews: true }

  const route = resolveNode(options.get("route"))
  const live = unwrapAst(options.get("live"))
  const previews = resolveNode(options.get("previews"))
  const features: Omit<ContentEntryFeatures, "github" | "sqlite"> = {
    route: !(isAstNode(route) && route.type === "Literal" && route.value === false),
    collections: false,
    sitemap: false,
    robots: false,
    markdown: false,
    rss: false,
    mcp: false,
    llms: false,
    live: !(isAstNode(live) && live.type === "Literal" && live.value === false),
    previews: options.has("previews") && !(isAstNode(previews) && previews.type === "Literal" && previews.value === false),
  }
  if (options.has("collections")) {
    const value = resolveNode(options.get("collections"))
    features.collections = !isAstNode(value) || value.type !== "ObjectExpression" || (Array.isArray(value.properties) && value.properties.length > 0)
  }
  if (options.has("seo")) {
    const seo = properties(resolveNode(options.get("seo")))
    if (!seo) return { ...features, sitemap: true, robots: true, markdown: true, rss: true, mcp: "unknown", llms: true }
    for (const key of ["sitemap", "robots", "markdown", "rss", "mcp", "llms"] as const) {
      if (!seo.has(key)) continue
      const value = key === "mcp" ? resolveNode(seo.get(key)) : unwrapAst(seo.get(key))
      if (key === "mcp" && (!isAstNode(value) || (value.type !== "Literal" && value.type !== "ObjectExpression"))) features.mcp = "unknown"
      else features[key] = !(isAstNode(value) && value.type === "Literal" && value.value === false)
    }
    // The llms files link to the `.md` copies.
    if (features.llms) features.markdown = true
  }
  return features
}

/** Read what the Content module defines without running it. A file that does not parse counts as defining everything. */
export async function inspectContentEntry(file: string, contentImportBase?: string): Promise<ContentEntryFeatures> {
  // `vite` is an optional peer. Content discovery runs inside Vite, so it is installed there.
  const { parseAst } = await import("vite")
  try {
    return inspectContentModule(parseAst(await readFile(file, "utf8"), { lang: /\.[cm]?ts$/.test(file) ? "ts" : "js" }), contentImportBase)
  }
  catch {
    // The runtime reports the syntax error.
    return { route: true, collections: true, sitemap: false, robots: false, markdown: false, rss: false, mcp: false, llms: false, live: true, previews: false, sqlite: false, github: false }
  }
}

async function writeContentArtifact(
  options: SourceGenerationOptions,
  file: string | undefined,
): Promise<GeneratedSourceHandler[]> {
  const output = resolve(options.projectRoot, contentRouteEntry)
  const preview = resolve(options.projectRoot, contentPreviewEntry)
  const sitemap = resolve(options.projectRoot, contentSitemapEntry)
  const robots = resolve(options.projectRoot, contentRobotsEntry)
  const markdown = resolve(options.projectRoot, contentMarkdownEntry)
  const rss = resolve(options.projectRoot, contentRssEntry)
  const mcp = resolve(options.projectRoot, contentMcpEntry)
  const llms = resolve(options.projectRoot, contentLlmsEntry)
  const sqlite = resolve(options.projectRoot, contentSqliteEntry)
  const githubWebhook = resolve(options.projectRoot, contentGitHubWebhookEntry)
  const previewRoutes = resolve(options.projectRoot, contentPreviewRoutesEntry)
  const typesPlugin = resolve(options.projectRoot, contentTypesPluginEntry)
  const types = resolve(options.projectRoot, contentTypesEntry)
  if (!file) {
    await Promise.all([output, preview, sitemap, robots, markdown, rss, mcp, llms, sqlite, githubWebhook, previewRoutes, typesPlugin, types].map(path => rm(path, { force: true })))
    return []
  }
  const importBase = JSON.stringify(options.contentImportBase ?? "@vite-hub/content")
  const contentModule = JSON.stringify(toRuntimeModuleSpecifier(file))
  const features = await inspectContentEntry(file, options.contentImportBase ?? "@vite-hub/content")
  // With Auth, every reader of published Content passes the session user of each request to `authorize` for
  // `action: "read"`. Entries that load when the server starts import Auth on the first request that asks.
  const sessionUser = (useAuth: string) => `async request => (await ${useAuth}(request).api.getSession({ headers: request.headers }))?.user ?? null`
  const authImport = options.auth ? [`import { useAuth } from ${JSON.stringify(authServerModuleId)}`] : []
  const readerOptions = options.auth ? `, { user: ${sessionUser("useAuth")} }` : ""
  const lazyReaderOptions = options.auth ? `, { user: ${sessionUser(`(await import(${JSON.stringify(authServerModuleId)})).useAuth`)} }` : ""
  if (features.route) await writeFileIfChanged(output, [
    `import { defineContentHandler } from ${importBase}`,
    ...authImport,
    `import content from ${contentModule}`,
    "",
    `export default defineContentHandler(content${readerOptions})`,
    "",
  ].join("\n"))
  else await rm(output, { force: true })
  const handlers: GeneratedSourceHandler[] = []
  // Cookie previews and signed Source links must bypass Nitro's cache, including apps without collections.
  // The small preview entry keeps the Content runtime and its Markdown renderer lazy.
  await writeFileIfChanged(preview, [
    `import { defineContentPreviewPlugin } from ${JSON.stringify(`${options.contentImportBase ?? "@vite-hub/content"}/preview`)}`,
    "",
    `export default defineContentPreviewPlugin(() => import(${contentModule}).then(module => module.default))`,
    "",
  ].join("\n"))
  handlers.push({ handler: preview, plugin: true })
  // A Nitro plugin: loads `vite-hub/content/sqlite` while the server starts. Content loads on its first request, and a
  // Cloudflare Worker compiles WebAssembly only while it starts, which SQLite WASM needs. On Node it loads Node SQLite.
  if (features.sqlite) {
    await writeFileIfChanged(sqlite, [
      `import { sqlite } from ${JSON.stringify(`${options.contentImportBase ?? "@vite-hub/content"}/sqlite`)}`,
      "",
      "// Returning the import keeps it in the bundle. A bare import is dropped, because the packages have no side effects.",
      "export default () => sqlite",
      "",
    ].join("\n"))
    handlers.push({ handler: sqlite, plugin: true })
  }
  else await rm(sqlite, { force: true })
  // A Nitro plugin: writes the types of `content.get()`, `content.list()`, and `content.query()` in development.
  await writeFileIfChanged(typesPlugin, [
    `import { defineContentTypesPlugin } from ${importBase}`,
    'import { useRuntimeConfig } from "nitro/runtime-config"',
    "",
    "// A production build drops this branch, so the server does not load Content at startup.",
    "const write = async (declarations) => {",
    '  const response = await fetch(useRuntimeConfig().vitehubContentTypesWriter, { method: "POST", body: declarations })',
    '  if (!response.ok) throw new Error(`Content types writer returned ${response.status}`)',
    "}",
    `export default import.meta.dev ? defineContentTypesPlugin(async () => (await import(${contentModule})).default, write, { moduleName: ${importBase} }) : () => {}`,
    "",
  ].join("\n"))
  handlers.push({ handler: typesPlugin, plugin: true })
  // Until the first development server writes the types, an empty file keeps the reference in `.vitehub/types.d.ts`.
  if (!await readFile(types, "utf8").then(() => true, () => false)) await writeFileIfChanged(types, "export {}\n")
  if (features.route) handlers.push({ handler: output, route: "/api/content/**" })
  // `github()` Sources serve a head commit. A signed GitHub push moves it through this route.
  if (features.github) {
    await writeFileIfChanged(githubWebhook, [
      `import { defineContentGitHubWebhookHandler } from ${importBase}`,
      `import content from ${contentModule}`,
      "",
      "export default defineContentGitHubWebhookHandler(content)",
      "",
    ].join("\n"))
    handlers.push({ handler: githubWebhook, method: "post", route: "/_vitehub/content/github" })
  }
  else await rm(githubWebhook, { force: true })
  // `previews: true` serves refs of a `github()` Source at `/tree`, `/blob`, and `/pr` URLs. A Nitro plugin, not a route:
  // the page runs with its production path through every route of the app. It loads server/content.ts on the first
  // preview URL only.
  if (features.previews) {
    await writeFileIfChanged(previewRoutes, [
      `import { defineContentPreviewRoutesPlugin } from ${JSON.stringify(`${options.contentImportBase ?? "@vite-hub/content"}/preview`)}`,
      "",
      `export default defineContentPreviewRoutesPlugin(() => import(${contentModule}).then(module => module.default)${lazyReaderOptions})`,
      "",
    ].join("\n"))
    handlers.push({ handler: previewRoutes, plugin: true, position: "start" })
  }
  else await rm(previewRoutes, { force: true })
  // `defineContent({ seo: { sitemap, robots, rss, mcp, llms } })` adds the site-wide SEO routes. One llms entry serves
  // three routes. The MCP server answers POST and refuses other methods itself.
  for (const [enabled, path, helper, routes] of [
    [features.sitemap, sitemap, "defineContentSitemapHandler", ["/sitemap.xml"]],
    [features.robots, robots, "defineContentRobotsHandler", ["/robots.txt"]],
    [features.rss, rss, "defineContentRssHandler", ["/rss.xml"]],
    [features.mcp, mcp, "defineContentMcpHandler", ["/mcp"]],
    [features.llms, llms, "defineContentLlmsHandler", ["/llms.txt", "/llms-full.txt", "/sitemap.md"]],
  ] as const) {
    if (!enabled) {
      await rm(path, { force: true })
      continue
    }
    // Unknown configuration must not reserve /mcp: a disabled Content server passes through to the app's handler.
    const conditionalMcp = routes[0] === "/mcp" && enabled === "unknown"
    // robots.txt names no page, so it does not ask `authorize`.
    const helperOptions = helper === "defineContentRobotsHandler" ? "" : readerOptions
    await writeFileIfChanged(path, [
      `import { ${helper} } from ${importBase}`,
      ...helperOptions ? authImport : [],
      `import content from ${contentModule}`,
      "",
      ...conditionalMcp ? [
        `const handler = ${helper}(content${helperOptions})`,
        "export default async event => {",
        "  if (!content.seo?.mcp) return",
        "  return await handler.fetch(event.req)",
        "}",
      ] : [`export default ${helper}(content${helperOptions})`],
      "",
    ].join("\n"))
    for (const route of routes) handlers.push(conditionalMcp ? { handler: path, middleware: true, route } : route === "/mcp" ? { handler: path, route } : { handler: path, method: "get", route })
  }
  // `seo: { markdown }` serves copies at every page URL plus `.md`, which no Nitro route pattern matches, so they are
  // middleware. It loads when the server starts, because it reads the response of later handlers for the Markdown 404.
  // It imports only the Markdown negotiation entry and loads server/content.ts on the first request that asks for Markdown.
  if (features.markdown) {
    await writeFileIfChanged(markdown, [
      `import { defineContentMarkdownHandler } from ${JSON.stringify(`${options.contentImportBase ?? "@vite-hub/content"}/markdown`)}`,
      "",
      `export default defineContentMarkdownHandler(() => import(${contentModule}).then(module => module.default)${lazyReaderOptions})`,
      "",
    ].join("\n"))
    handlers.push({ handler: markdown, middleware: true, lazy: false, route: "/**" })
  }
  else await rm(markdown, { force: true })
  return handlers
}

async function prepareSourceArtifacts(options: SourceGenerationOptions): Promise<{ content?: ContentDefinitionFile, handlers: GeneratedSourceHandler[] }> {
  const [collections, content] = await Promise.all([
    discoverCollections(options),
    findContentEntry(options),
  ])
  const handlers = [
    ...await writeCollectionArtifacts(options, collections),
    ...await writeContentArtifact(options, content),
  // Plugins have no route and sort first.
  ].sort((left, right) => (left.route ?? "").localeCompare(right.route ?? ""))
  return { handlers, ...(content ? { content: { handler: content } } : {}) }
}

export async function prepareSourceGeneration(options: SourceGenerationOptions): Promise<GeneratedSourceHandler[]> {
  return (await prepareSourceArtifacts(options)).handlers
}

/** Nuxt serves Vite assets from `/_nuxt/`, so its Vite `base` is not the app base. `vite-hub/nuxt` passes the app base. */
function applicationBaseURL(config: { base?: string }): string {
  const configured: unknown = Reflect.get(config, VITEHUB_APP_BASE_URL)
  const base = typeof configured === "string" ? configured : config.base
  return base?.startsWith("/") && !base.startsWith("//") ? base : "/"
}

async function generatedHandlerKey(handlers: GeneratedSourceHandler[]): Promise<string> {
  return JSON.stringify(await Promise.all(handlers.map(async handler => ({
    ...handler,
    contents: await readFile(handler.handler, "utf8"),
  }))))
}

function generatedSourceNitroContribution(
  value: unknown,
  generatedHandlers: GeneratedSourceHandler[],
): NitroGeneratedConfig | undefined {
  let existing: NitroGeneratedConfig = {}
  if (Object(value) === value && !Array.isArray(value)) {
    // SAFETY: the runtime guard excludes primitives and arrays before treating the config as a Nitro config record.
    existing = value as NitroGeneratedConfig
  }
  const merged = mergeGeneratedSourceNitroConfig(existing, generatedHandlers)
  const handlers = merged.handlers?.slice(Array.isArray(existing.handlers) ? existing.handlers.length : 0)
  const modules = merged.modules?.slice(Array.isArray(existing.modules) ? existing.modules.length : 0)
  const plugins = merged.plugins?.filter(plugin => !existing.plugins?.includes(plugin))
  if (!handlers?.length && !modules?.length && !plugins?.length) return
  const contribution: NitroGeneratedConfig = {}
  if (handlers?.length) contribution.handlers = handlers
  if (modules?.length) contribution.modules = modules
  if (plugins?.length) contribution.plugins = plugins
  return contribution
}

function sourceDefinitionPath(file: string, projectRoot: string, serverDirs: string[] | undefined): boolean {
  const projectRelativePath = relative(resolve(projectRoot), resolve(file)).replaceAll("\\", "/")
  if (/^server\.auth\.(?:[cm]?[jt]s)$/.test(projectRelativePath)) return true
  const directories = serverDirs === undefined ? [resolve(projectRoot, "server")] : serverDirs
  return directories.some((directory) => {
    const path = relative(resolve(projectRoot, directory), resolve(file)).replaceAll("\\", "/")
    if (path.startsWith("../") || isAbsolute(path)) return false
    return /^content\.(?:[cm]?[jt]s)$/.test(path)
      || /^auth\.(?:[cm]?[jt]s)$/.test(path)
      || (/^collections\/.+\.(?:[cm]?[jt]s)$/.test(path) && !/\.d\.[cm]?ts$/.test(path))
  })
}

export function hubSource(options: SourceVitePluginOptions = {}): Plugin & {
  api: {
    /** The `server/content.ts` file found by the last preparation of `projectRoot` (default: the latest root). */
    getContentDefinition: (projectRoot?: string) => ContentDefinitionFile | undefined
    onGeneratedHandlersChanged: (
      listener: GeneratedSourceHandlersListener,
      options?: GeneratedSourceHandlersListenerOptions,
    ) => () => void
    prepareSources: (options: Omit<SourceGenerationOptions, "auth" | "contentImportBase" | "importBase">) => Promise<GeneratedSourceHandler[]>
  }
  nitro: { name: string, setup(nitro: SourceNitroHost): Promise<void> }
  vitehub: ViteHubInspectionPluginMetadata
} {
  const refreshAuthByRoot = new Map<string, () => unknown>()
  let nitroHost: SourceNitroHost | undefined
  let nitroHostContribution: NitroGeneratedConfig | undefined
  const nitroHandlers: GeneratedSourceHandler[] = []
  let latestProjectRoot: string | undefined
  const configuredStateByRoot = new Map<string, {
    handlerKey: string
    nitroContribution?: NitroGeneratedConfig
    serverDirs?: string[]
  }>()
  const closeHostRefreshByEnvironment = new WeakMap<object, () => void>()
  const hostRefreshLifecycleByRoot = new Map<string, {
    close: () => void
    pause: () => void
    resume: () => void
  }>()
  const sourcePreparationByRoot = new Map<string, Promise<unknown>>()
  const contentDefinitionByRoot = new Map<string, ContentDefinitionFile>()
  const getContentDefinition = (projectRoot?: string) => {
    const root = projectRoot ? resolve(projectRoot) : latestProjectRoot
    return root ? contentDefinitionByRoot.get(root) : undefined
  }
  const configurationTransitionByRoot = new Map<string, Promise<unknown>>()
  let legacyServerBuild = false
  const generatedHandlersListeners = new Set<{
    handlesHostRestart?: boolean
    listener: GeneratedSourceHandlersListener
    projectRoot?: string
  }>()
  const prepareSources = (
    input: Omit<SourceGenerationOptions, "auth" | "contentImportBase" | "importBase">,
  ) => {
    const root = resolve(input.projectRoot)
    const previousPreparation = sourcePreparationByRoot.get(root) ?? Promise.resolve()
    const runPreparation = () => {
      const auth = typeof options.auth === "function"
        ? options.auth({ projectRoot: root, serverDirs: input.serverDirs })
        : options.auth && Boolean(refreshAuthByRoot.get(root)?.())
      return prepareSourceArtifacts({
        ...input,
        auth,
        importBase: options.importBase,
        contentImportBase: options.contentImportBase,
      }).then(({ content, handlers }) => {
        if (content) contentDefinitionByRoot.set(root, content)
        else contentDefinitionByRoot.delete(root)
        return handlers
      })
    }
    const preparation = previousPreparation.then(runPreparation, runPreparation)
    sourcePreparationByRoot.set(root, preparation)
    void preparation.finally(() => {
      if (sourcePreparationByRoot.get(root) === preparation) sourcePreparationByRoot.delete(root)
    }).catch(() => {})
    return preparation
  }
  const refresh = async (viteConfig?: SourcePluginConfig) => {
    const projectRoot = viteConfig?.[VITEHUB_PROJECT_ROOT]
      ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
      : viteConfig?.root
        ? resolveViteHubProjectRoot(viteConfig.root)
        : latestProjectRoot
    if (!projectRoot) return
    await prepareSources({
      projectRoot,
      serverDirs: configuredStateByRoot.get(projectRoot)?.serverDirs,
    })
  }
  const onGeneratedHandlersChanged = (
    listener: GeneratedSourceHandlersListener,
    listenerOptions: GeneratedSourceHandlersListenerOptions = {},
  ) => {
    const registration = {
      ...listenerOptions,
      listener,
      projectRoot: listenerOptions.projectRoot
        ? resolve(listenerOptions.projectRoot)
        : latestProjectRoot,
    }
    generatedHandlersListeners.add(registration)
    return () => generatedHandlersListeners.delete(registration)
  }
  const bindUnresolvedListenerRoots = (root: string) => {
    for (const listenerOptions of generatedHandlersListeners.values()) {
      listenerOptions.projectRoot ??= root
    }
  }
  const replaceConfiguredNitroContribution = (
    value: unknown,
    handlers: GeneratedSourceHandler[],
    configuredNitroContribution: NitroGeneratedConfig | undefined,
  ): NitroGeneratedConfig => {
    let nitro: NitroGeneratedConfig = {}
    if (Object(value) === value && !Array.isArray(value)) {
      // SAFETY: the runtime guard excludes primitives and arrays before treating the config as a Nitro config record.
      nitro = { ...(value as NitroGeneratedConfig) }
    }
    const contributedHandlers = configuredNitroContribution?.handlers ?? []
    if (Array.isArray(nitro.handlers) && contributedHandlers.length > 0) {
      nitro.handlers = nitro.handlers.filter(handler => !contributedHandlers.includes(handler))
    }
    const contributedModules = configuredNitroContribution?.modules ?? []
    if (Array.isArray(nitro.modules) && contributedModules.length > 0) {
      nitro.modules = nitro.modules.filter(module => !contributedModules.includes(module))
    }
    const contributedPlugins = configuredNitroContribution?.plugins ?? []
    if (Array.isArray(nitro.plugins) && contributedPlugins.length > 0) {
      nitro.plugins = nitro.plugins.filter(plugin => !contributedPlugins.includes(plugin))
    }
    return mergeGeneratedSourceNitroConfig(nitro, handlers)
  }
  return {
    name: "@vite-hub/source/vite",
    enforce: "post",
    api: { getContentDefinition, onGeneratedHandlersChanged, prepareSources },
    // glob() in a server build: calls with literal options become their files, bundled (internal/bundle-glob.ts).
    // The filters keep Rolldown from calling these hooks for every other module.
    resolveId: {
      filter: { id: BUNDLED_GLOB_ID_PATTERN },
      handler(id) {
        return id
      },
    },
    load: {
      filter: { id: BUNDLED_GLOB_ID_PATTERN },
      async handler(id) {
        const { code, watched } = await loadBundledGlob(id, latestProjectRoot ?? resolveViteHubProjectRoot(process.cwd()))
        for (const file of watched) this.addWatchFile(file)
        return code
      },
    },
    transform: {
      filter: { id: { exclude: /\/node_modules\// }, code: /\bvite-hub\/source["'`]/ },
      handler(code, _id, options) {
        const environment = this.environment?.config
        const server = environment
          ? environment.consumer === "server"
          : options?.ssr === true && legacyServerBuild
        if (!server || (environment && environment.command !== "build")) return
        const calls = findGlobCalls(this.parse(code) as unknown as Parameters<typeof findGlobCalls>[0])
        for (const call of calls.filter(call => call.input === undefined)) {
          this.warn({
            message: "[vitehub] glob() here takes options that are not literals, so the build cannot bundle its files. It reads them from disk at runtime, which hosts such as Cloudflare Workers do not have.",
            pos: call.start,
          })
        }
        if (calls.some(call => call.input !== undefined)) return { code: rewriteGlobCalls(code, calls), map: null }
      },
    },
    vitehub: {
      inspect: () => ({
        definitions: [{
          kind: "collection",
          label: "Collections",
          list: () => {
            const projectRoot = latestProjectRoot ?? resolveViteHubProjectRoot(process.cwd())
            return inspectCollectionDefinitions({ projectRoot, serverDirs: configuredStateByRoot.get(projectRoot)?.serverDirs })
          },
        }],
      }),
    },
    nitro: {
      name: "@vite-hub/source/generated-routes",
      async setup(nitro) {
        nitroHost = nitro
        nitroHostContribution = undefined
        await generatedRouteGuard(nitroHandlers).setup(nitro)
      },
    },
    async config(config, env) {
      // SAFETY: Vite passes its user config with ViteHub's shared symbols attached.
      const viteConfig = config as SourcePluginConfig
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) return
      legacyServerBuild = env.command === "build" && config.build?.ssr === true
      const projectRoot = viteConfig[VITEHUB_PROJECT_ROOT]
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(viteConfig.root || process.cwd())
      latestProjectRoot = projectRoot
      bindUnresolvedListenerRoots(projectRoot)
      const serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const previousTransition = configurationTransitionByRoot.get(projectRoot) ?? Promise.resolve()
      const runTransition = async () => {
        const previousLifecycle = hostRefreshLifecycleByRoot.get(projectRoot)
        const previousConfiguredState = configuredStateByRoot.get(projectRoot)
        previousLifecycle?.pause()
        try {
          const handlers = await prepareSources({ projectRoot, serverDirs })
          const handlerKey = await generatedHandlerKey(handlers)
          const nitro = generatedSourceNitroContribution(viteConfig.nitro, handlers)
          configuredStateByRoot.set(projectRoot, {
            handlerKey,
            nitroContribution: nitro,
            serverDirs: serverDirs?.slice(),
          })
          const contribution: SourcePluginConfig = {
            define: { __VITEHUB_APP_BASE_URL__: JSON.stringify(applicationBaseURL(viteConfig)) },
            ...(nitro ? { nitro } : {}),
          }
          previousLifecycle?.close()
          return contribution
        }
        catch (error) {
          try {
            if (previousConfiguredState) {
              await prepareSources({
                projectRoot,
                serverDirs: previousConfiguredState.serverDirs,
              })
            }
          }
          finally {
            previousLifecycle?.resume()
          }
          throw error
        }
      }
      const transition = previousTransition.then(runTransition, runTransition)
      configurationTransitionByRoot.set(projectRoot, transition)
      void transition.finally(() => {
        if (configurationTransitionByRoot.get(projectRoot) === transition) {
          configurationTransitionByRoot.delete(projectRoot)
        }
      }).catch(() => {})
      // SAFETY: Vite merges the contribution into its user config. Its `nitro` key is Nitro's own config shape, which
      // this package types loosely so it does not depend on Nitro's types.
      return transition as Promise<Omit<UserConfig, "plugins"> | undefined>
    },
    async configResolved(config) {
      // SAFETY: Vite's resolved config retains the ViteHub symbols added during the config hook.
      const viteConfig = config as SourcePluginConfig
      const projectRoot = viteConfig[VITEHUB_PROJECT_ROOT]
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(config.root)
      latestProjectRoot = projectRoot
      bindUnresolvedListenerRoots(projectRoot)
      // Auth owns discovery. Refresh it during preparation so watcher listener order cannot leave stale imports.
      const authPlugin = (config.plugins ?? []).flat(Infinity).find(plugin => plugin.name === "@vite-hub/auth/vite")
      const refreshAuth: unknown = Reflect.get(Object(Reflect.get(Object(authPlugin), "api")), "refresh")
      if (refreshAuth instanceof Function) refreshAuthByRoot.set(projectRoot, () => refreshAuth())
      else refreshAuthByRoot.delete(projectRoot)
      viteConfig.define ??= {}
      viteConfig.define.__VITEHUB_APP_BASE_URL__ = JSON.stringify(applicationBaseURL(config))
      const previousTransition = configurationTransitionByRoot.get(projectRoot) ?? Promise.resolve()
      const runTransition = async () => {
        const configuredState = configuredStateByRoot.get(projectRoot)
        const serverDirs = viteConfig[VITEHUB_SERVER_DIRS] ?? configuredState?.serverDirs
        const handlers = await prepareSources({ projectRoot, serverDirs })
        const handlerKey = await generatedHandlerKey(handlers)
        if (nitroHost && !viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) {
          // Nitro initializes before post-enforced config hooks. Reconcile its routes once
          // Vite has resolved the root and server directories from all config contributions.
          assertGeneratedRoutes(nitroHost, handlers)
          const nitro = replaceConfiguredNitroContribution(nitroHost.options, handlers, nitroHostContribution)
          nitroHostContribution = {
            handlers: nitro.handlers?.filter(handler => handlers.some(generated =>
              !generated.plugin && handler.handler === generated.handler && handler.route === generated.route && handler.method === generated.method)),
            plugins: handlers.flatMap(generated => generated.plugin ? [generated.handler] : []),
          }
          nitroHost.options.handlers = nitro.handlers
          nitroHost.options.plugins = nitro.plugins
          nitroHandlers.splice(0, nitroHandlers.length, ...handlers)
          const typesPlugin = handlers.find(handler => handler.plugin && handler.handler.replaceAll("\\", "/").endsWith(`/${contentTypesPluginEntry}`))
          if (typesPlugin) await installContentTypesWriter(nitroHost, typesPlugin.handler)
          nitroHost.routing.sync()
        }
        configuredStateByRoot.set(projectRoot, {
          handlerKey,
          nitroContribution: configuredState?.nitroContribution,
          serverDirs: serverDirs?.slice(),
        })
        if (!viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) {
          viteConfig.nitro = replaceConfiguredNitroContribution(
            viteConfig.nitro,
            handlers,
            configuredState?.nitroContribution,
          )
        }
      }
      const transition = previousTransition.then(runTransition, runTransition)
      configurationTransitionByRoot.set(projectRoot, transition)
      void transition.finally(() => {
        if (configurationTransitionByRoot.get(projectRoot) === transition) {
          configurationTransitionByRoot.delete(projectRoot)
        }
      }).catch(() => {})
      return transition
    },
    configureServer(server) {
      // SAFETY: SourcePluginConfig only adds ViteHub's symbol-keyed metadata to Vite's resolved config.
      const viteConfig = server.config as SourcePluginConfig
      const root = viteConfig[VITEHUB_PROJECT_ROOT]
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(server.config.root ?? latestProjectRoot ?? process.cwd())
      const configuredState = configuredStateByRoot.get(root)
      const lifecycleServerDirs = configuredState?.serverDirs?.slice()
      let activeHandlerKey = configuredState?.handlerKey ?? "[]"
      const effectiveServerDirs = lifecycleServerDirs === undefined
        ? root ? [resolve(root, "server")] : []
        : root ? lifecycleServerDirs.map(directory => resolve(root, directory)) : []
      server.watcher.add(effectiveServerDirs)
      let hostRefreshRetry: ReturnType<typeof setTimeout> | undefined
      let pausedHostRefreshRetryFile: string | undefined
      let hostRefreshRetryDelay = initialHostRefreshRetryDelay
      let refreshQueue = Promise.resolve()
      let serverClosed = false
      let serverPaused = false
      const clearHostRefreshRetry = () => {
        if (hostRefreshRetry) clearTimeout(hostRefreshRetry)
        hostRefreshRetry = undefined
      }
      const closeHostRefresh = () => {
        serverClosed = true
        clearHostRefreshRetry()
        if (root && hostRefreshLifecycleByRoot.get(root)?.close === closeHostRefresh) {
          hostRefreshLifecycleByRoot.delete(root)
        }
      }
      if (root) {
        hostRefreshLifecycleByRoot.get(root)?.close()
        hostRefreshLifecycleByRoot.set(root, {
          close: closeHostRefresh,
          pause: () => { serverPaused = true },
          resume: () => {
            serverPaused = false
            if (pausedHostRefreshRetryFile) {
              const file = pausedHostRefreshRetryFile
              pausedHostRefreshRetryFile = undefined
              scheduleHostRefreshRetry(file)
            }
          },
        })
      }
      for (const environment of Object.values(server.environments)) {
        closeHostRefreshByEnvironment.set(environment, closeHostRefresh)
      }
      const scheduleHostRefreshRetry = (file: string) => {
        if (hostRefreshRetry) return
        hostRefreshRetry = setTimeout(() => {
          hostRefreshRetry = undefined
          if (serverClosed) return
          if (serverPaused) {
            pausedHostRefreshRetryFile = file
            return
          }
          void queueHostRefresh(file)
        }, hostRefreshRetryDelay)
        hostRefreshRetry.unref?.()
        hostRefreshRetryDelay = Math.min(hostRefreshRetryDelay * 2, maximumHostRefreshRetryDelay)
      }
      function queueHostRefresh(file: string) {
        if (serverClosed || !root || !sourceDefinitionPath(file, root, lifecycleServerDirs)) return
        if (serverPaused) {
          pausedHostRefreshRetryFile = file
          return
        }
        const result = refreshQueue.then(async () => {
          if (serverClosed) return
          if (serverPaused) {
            pausedHostRefreshRetryFile = file
            return
          }
          const previousArtifacts = await snapshotGeneratedSourceArtifacts(root)
          const handlers = await prepareSources({ projectRoot: root, serverDirs: lifecycleServerDirs })
          if (serverClosed) return
          if (serverPaused) {
            pausedHostRefreshRetryFile = file
            return
          }
          const handlerKey = await generatedHandlerKey(handlers)
          if (serverClosed) return
          if (serverPaused) {
            pausedHostRefreshRetryFile = file
            return
          }
          if (handlerKey === activeHandlerKey) return
          const listeners = [...generatedHandlersListeners].filter(listenerOptions =>
            listenerOptions.projectRoot === root,
          )
          const passiveListeners = listeners.filter(listenerOptions =>
            !listenerOptions.handlesHostRestart,
          )
          for (const { listener } of passiveListeners) {
            void Promise.resolve()
              .then(() => listener(handlers))
              .catch(error => server.config.logger.error(String(error)))
          }
          const hostRestartOwners = listeners.filter(listenerOptions =>
            listenerOptions.handlesHostRestart,
          )
          const listenerResults = hostRestartOwners.map(async ({ listener }) => {
            try {
              await listener(handlers)
              return true
            }
            catch (error) {
              server.config.logger.error(String(error))
              return false
            }
          })
          let ownerSettlementTimeout: ReturnType<typeof setTimeout> | undefined
          const ownerSettlement = Promise.race([
            Promise.all(listenerResults).then(results => results.some(Boolean)),
            Promise.any(listenerResults.map(async result => (await result) || Promise.reject())).then(
              () => true,
              () => false,
            ),
            new Promise<false>((resolve) => {
              ownerSettlementTimeout = setTimeout(() => resolve(false), hostRestartOwnerSettlementTimeout)
              ownerSettlementTimeout.unref?.()
            }),
          ])
          const hostRestartHandled = await ownerSettlement
          if (ownerSettlementTimeout) clearTimeout(ownerSettlementTimeout)
          if (serverClosed) return
          const hasHostRestartOwner = hostRestartOwners.length > 0
          if (hasHostRestartOwner && !hostRestartHandled) {
            await restoreGeneratedSourceArtifacts(root, previousArtifacts)
            scheduleHostRefreshRetry(file)
            return
          }
          if (!hasHostRestartOwner) {
            const previousEnvironments = server.environments
            try {
              await server.restart()
            }
            catch (error) {
              if (serverClosed) return
              await restoreGeneratedSourceArtifacts(root, previousArtifacts)
              scheduleHostRefreshRetry(file)
              throw error
            }
            if (serverClosed) return
            if (server.environments === previousEnvironments) {
              await restoreGeneratedSourceArtifacts(root, previousArtifacts)
              scheduleHostRefreshRetry(file)
              return
            }
          }
          activeHandlerKey = handlerKey
          clearHostRefreshRetry()
          hostRefreshRetryDelay = initialHostRefreshRetryDelay
        })
        refreshQueue = result.catch(() => {})
        void result.catch(error => server.config.logger.error(String(error)))
        return result
      }
      const refreshHost = (file: string) => {
        if (!root || !sourceDefinitionPath(file, root, lifecycleServerDirs)) return
        clearHostRefreshRetry()
        hostRefreshRetryDelay = initialHostRefreshRetryDelay
        return queueHostRefresh(file)
      }
      server.watcher.on("add", refreshHost)
      server.watcher.on("change", refreshHost)
      server.watcher.on("unlink", refreshHost)
    },
    buildStart() {
      // SAFETY: SourcePluginConfig only adds ViteHub's symbol-keyed metadata to the hook config.
      return refresh(this.environment?.config as SourcePluginConfig | undefined)
    },
    buildEnd() {
      // SAFETY: SourcePluginConfig only adds ViteHub's symbol-keyed metadata to the hook config.
      return refresh(this.environment?.config as SourcePluginConfig | undefined)
    },
    closeBundle() {
      closeHostRefreshByEnvironment.get(this.environment)?.()
      closeHostRefreshByEnvironment.delete(this.environment)
    },
  }
}
