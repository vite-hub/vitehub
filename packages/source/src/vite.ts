import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  resolveViteHubProjectRoot,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_PROJECT_ROOT,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { findExportNames } from "mlly"

import { parseSync as parseJavaScript } from "vite"
import type { Plugin } from "vite"
import { inspectCollectionDefinitions } from "./inspect.ts"
import { collectCollectionFiles, discoverCollections } from "./internal/collection-discovery.ts"
import { collectionRoutePath } from "./internal/collection-route.ts"
import { sourceErrorDiagnostics } from "./error-diagnostics.ts"

import type { DiscoveredCollection } from "./internal/collection-discovery.ts"

export { inspectCollectionDefinitions, type CollectionInspectionOptions } from "./inspect.ts"

const collectionTypesEntry = ".vitehub/types/source/collections.d.ts"
const collectionTypesPackageEntry = ".vitehub/types/source/vitehub-source-registry.d.ts"
const collectionRoutesDirectory = ".vitehub/source/routes"
const contentRouteEntry = ".vitehub/content/route.mjs"
const contentPreviewEntry = ".vitehub/content/preview.mjs"
// Auth owns this virtual module. Generated routes import it only when Auth is enabled.
const authServerModuleId = "#vitehub/auth/server"
const initialHostRefreshRetryDelay = 25
const maximumHostRefreshRetryDelay = 1_000
const hostRestartOwnerSettlementTimeout = 30_000

/** A file ViteHub generates for Nitro: a route handler, or a Nitro plugin such as the Content preview scope. */
export type GeneratedSourceHandler = GeneratedSourceRoute | GeneratedSourcePlugin

export interface GeneratedSourceRoute {
  handler: string
  method?: "get"
  plugin?: never
  route: string
}

/** A generated Nitro plugin. It registers no route, so it never conflicts with one. */
export interface GeneratedSourcePlugin {
  handler: string
  method?: never
  plugin: true
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
  auth?: boolean | ((input: { configuredAuth?: boolean, projectRoot: string, serverDirs?: string[] }) => boolean)
  contentImportBase?: string
  importBase?: string
}

export type GeneratedSourceHandlersListener = (handlers: GeneratedSourceHandler[]) => Promise<void> | void

export interface GeneratedSourceHandlersListenerOptions {
  handlesHostRestart?: boolean
  projectRoot?: string
}

interface DiscoveredCollection {
  exportName: string
  file: string
  name: string
  routeEnabled: boolean
}

interface NitroGeneratedConfig {
  handlers?: Array<{ handler: string, method?: string, middleware?: boolean, route?: string }>
  modules?: unknown[]
  plugins?: unknown[]
}

interface SourceNitroHost extends NitroRouteGuard {
  options: NitroGeneratedConfig
  routing: { sync(): void }
}

interface NitroRouteGuard {
  hooks: { hook(name: "build:before", callback: () => void): void }
  scannedHandlers: Array<{ method?: string, middleware?: boolean, route?: string }>
}

interface SourcePluginConfig {
  auth?: false | Record<string, never>
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
    collectionTypesPackageEntry,
    contentRouteEntry,
    contentPreviewEntry,
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
    collectionTypesPackageEntry,
    contentRouteEntry,
    contentPreviewEntry,
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
  return handler.route === "/api/content/**" ? "Content" : "Collection"
}

function generatedRouteDescription(handler: GeneratedSourceRoute): string {
  return handler.method ? `${handler.method.toUpperCase()} handler` : "handler"
}

function assertGeneratedRoutes(nitro: NitroRouteGuard, generatedHandlers: GeneratedSourceHandler[]): void {
  for (const generatedHandler of generatedHandlers) {
    if (generatedHandler.plugin) continue
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
    setup(nitro: NitroRouteGuard) {
      nitro.hooks.hook("build:before", () => assertGeneratedRoutes(nitro, generatedHandlers))
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
      kit.addPlugin(handler.handler)
      continue
    }
    const exact = handlers.some(candidate =>
      candidate.handler === handler.handler
      && candidate.route === handler.route
      && candidate.method?.toLowerCase() === handler.method?.toLowerCase())
    if (exact) continue
    const duplicate = handlers.some(candidate =>
      !candidate.middleware && candidate.route === handler.route && methodsOverlap(candidate.method, handler.method))
    if (duplicate) {
      throw sourceErrorDiagnostics.SOURCE_B0002({ message: `[vitehub] Generated ${generatedRouteOwner(handler)} route ${JSON.stringify(handler.route)} conflicts with an existing ${generatedRouteDescription(handler)}. Remove the matching server route.` })
    }
    kit.addHandler(handler)
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

async function collectCollectionFiles(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  }
  catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectCollectionFiles(path))
    else if (entry.isFile() && /\.(?:[cm]?[jt]s)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) files.push(path)
  }
  return files
}

/** Inspect route metadata without importing Collection modules or evaluating loaders. */
function collectionRouteEnabled(file: string, source: string, exportName: string): boolean {
  // Collection files may use TypeScript syntax regardless of their extension
  // (for example a `.mjs` file supplied by a generated-types fixture).
  const parsed = parseJavaScript(file, source, { lang: "ts" })
  if (parsed.errors.length) throw new TypeError(`[vitehub] Cannot parse Collection ${file}: ${parsed.errors[0]!.message}`)
  type AstNode = {
    type?: string
    start?: number
    object?: AstNode
    property?: AstNode
    test?: AstNode
    consequent?: AstNode
    alternate?: AstNode
    name?: string
    value?: unknown
    expression?: AstNode | null
    callee?: AstNode | null
    argument?: AstNode | null
    arguments?: AstNode[]
    properties?: AstNode[]
    key?: AstNode
    computed?: boolean
    declarations?: AstNode[]
    init?: AstNode | null
    kind?: string
    params?: AstNode[]
    param?: AstNode | null
    id?: AstNode
    local?: AstNode
    exported?: AstNode
    elements?: Array<AstNode | null>
    expressions?: AstNode[]
    quasis?: Array<{ value?: { raw?: string, cooked?: string } }>
    operator?: string
    left?: AstNode
    right?: AstNode
    body?: AstNode | AstNode[] | null
  }
  type Write = { node: AstNode; fn?: AstNode; guards: Array<{ test: AstNode | undefined; truthy: boolean }> }
  type Binding = { init?: AstNode | null; writes?: Write[] }
  type Scope = { bindings: Map<string, Binding>, parent?: Scope }
  const moduleScope: Scope = { bindings: new Map() }
  const scopes = new WeakMap<AstNode, Scope>()
  const bindPattern = (node: AstNode | null | undefined, scope: Scope, init?: AstNode | null): void => {
    if (!node) return
    if (node.type === "Identifier" && node.name) scope.bindings.set(node.name, { init })
    else if (node.type === "RestElement") bindPattern(node.argument, scope)
    else if (node.type === "AssignmentPattern") bindPattern(node.left, scope, { type: "AssignmentPattern", left: init ?? undefined, right: node.right })
    else if (node.type === "ArrayPattern") for (const element of node.elements ?? []) bindPattern(element, scope)
    else if (node.type === "ObjectPattern") for (const property of node.properties ?? []) {
      const member: AstNode = { type: "MemberExpression", object: init ?? undefined, property: property.key, computed: property.computed }
      scopes.set(member, scope)
      // SAFETY: Object-pattern properties hold another binding pattern in value.
      bindPattern(property.type === "RestElement" ? property.argument : property.value as AstNode, scope, property.type === "RestElement" ? undefined : member)
    }
  }
  const indexScopes = (node: AstNode, parent: Scope, functionScope: Scope): void => {
    const isFunction = ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type ?? "")
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id?.name) {
      parent.bindings.set(node.id.name, { init: node.type === "FunctionDeclaration" ? node : undefined })
    }
    const createsScope = isFunction || ["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement"].includes(node.type ?? "")
    const scope: Scope = createsScope ? { bindings: new Map(), parent } : parent
    const nextFunctionScope = isFunction ? scope : functionScope
    scopes.set(node, scope)
    if (isFunction) {
      for (const param of node.params ?? []) bindPattern(param, scope)
      if (node.type === "FunctionExpression") bindPattern(node.id, scope)
    }
    if (node.type === "CatchClause") bindPattern(node.param, scope)
    if (node.type === "VariableDeclaration") for (const item of node.declarations ?? []) {
      const target = node.kind === "var" ? functionScope : scope
      bindPattern(item.id, target, item.init)
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item) {
          // SAFETY: Parser-owned AST arrays contain child nodes (or null array holes).
          indexScopes(item as AstNode, scope, nextFunctionScope)
        }
      }
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- AST child traversal excludes scalar metadata from parser-owned nodes.
      else if (child && typeof child === "object") {
        // SAFETY: Traversal reads only optional AST fields from parser-owned child objects.
        indexScopes(child as AstNode, scope, nextFunctionScope)
      }
    }
  }
  // SAFETY: The parser's AST nodes expose the expression and binding fields inspected above.
  indexScopes(parsed.program as AstNode, moduleScope, moduleScope)
  const bindingFor = (node: AstNode): Binding | undefined => {
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      if (node.name && scope.bindings.has(node.name)) return scope.bindings.get(node.name)
    }
    return undefined
  }
  const indexedWrites: Write[] = []
  const indexWrites = (node: AstNode, fn?: AstNode, guards: Write["guards"] = []): void => {
    if (["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type ?? "")) {
      fn = node
      guards = []
    }
    if (node.type === "IfStatement" || node.type === "ConditionalExpression") {
      if (node.consequent) indexWrites(node.consequent, fn, [...guards, { test: node.test, truthy: true }])
      if (node.alternate) indexWrites(node.alternate, fn, [...guards, { test: node.test, truthy: false }])
      return
    }
    if (node.type === "LogicalExpression") {
      if (node.left) indexWrites(node.left, fn, guards)
      if (node.right) indexWrites(node.right, fn, [...guards, { test: node.operator === "??" ? undefined : node.left, truthy: node.operator === "&&" }])
      return
    }
    if (["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "SwitchStatement", "TryStatement"].includes(node.type ?? "")) guards = [...guards, { test: undefined, truthy: true }]
    if (node.type === "UnaryExpression" && node.operator === "delete" && node.argument?.type === "MemberExpression") {
      const target = node.argument.object
      const binding = target?.type === "Identifier" ? bindingFor(target) : undefined
      if (binding) {
        const write = { node, fn, guards }
        ;(binding.writes ??= []).push(write)
        indexedWrites.push(write)
      }
    }
    if (node.type === "AssignmentExpression") {
      const target = node.left?.type === "MemberExpression" ? node.left.object : node.left
      const binding = target?.type === "Identifier" ? bindingFor(target) : undefined
      if (binding) {
        const write = { node, fn, guards }
        ;(binding.writes ??= []).push(write)
        indexedWrites.push(write)
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) if (item) {
          // SAFETY: Parser-owned AST arrays contain child nodes.
          indexWrites(item as AstNode, fn, guards)
          // SAFETY: Parser-owned child nodes expose their ESTree statement type.
          if ((item as AstNode).type === "ReturnStatement" || (item as AstNode).type === "ThrowStatement") break
        }
      }
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only traverse parser-owned child objects.
      else if (child && typeof child === "object") {
        // SAFETY: Parser-owned AST children expose optional common node fields.
        indexWrites(child as AstNode, fn, guards)
      }
    }
  }
  // SAFETY: The parser owns the AST traversed to index writes.
  indexWrites(parsed.program as AstNode)
  let readPosition = Infinity
  const activeFunctions = new Set<AstNode>()
  const executedFunctions = new Set<AstNode>()
  const parameterValues = new Map<Binding, AstNode | undefined>()
  let routeEffectState: boolean | undefined
  const snapshotExecution = (): {
    activeFunctions: Set<AstNode>
    executedFunctions: Set<AstNode>
    parameterValues: Map<Binding, AstNode | undefined>
    readPosition: number
    routeEffectState: boolean | undefined
  } => ({
    activeFunctions: new Set(activeFunctions),
    executedFunctions: new Set(executedFunctions),
    parameterValues: new Map(parameterValues),
    readPosition,
    routeEffectState,
  })
  const restoreExecution = (snapshot: ReturnType<typeof snapshotExecution>): void => {
    activeFunctions.clear()
    for (const fn of snapshot.activeFunctions) activeFunctions.add(fn)
    executedFunctions.clear()
    for (const fn of snapshot.executedFunctions) executedFunctions.add(fn)
    parameterValues.clear()
    for (const [binding, value] of snapshot.parameterValues) parameterValues.set(binding, value)
    readPosition = snapshot.readPosition
    routeEffectState = snapshot.routeEffectState
  }
  let exported = moduleScope.bindings.get(exportName)
  for (const statement of parsed.program.body) {
    if (statement.type !== "ImportDeclaration") continue
    for (const specifier of statement.specifiers ?? []) {
      const imported = specifier.type === "ImportSpecifier" ? specifier.imported : undefined
      const name = imported?.type === "Identifier" ? imported.name : imported?.value
      moduleScope.bindings.set(specifier.local.name, { init: { type: name === "defineCollection" ? "CollectionFactory" : specifier.type === "ImportNamespaceSpecifier" ? "CollectionNamespace" : "UnknownImport" } })
    }
  }
  for (const statement of parsed.program.body) {
    if (statement.type === "ExportNamedDeclaration") for (const specifier of statement.specifiers) {
      if (specifier.type === "ExportSpecifier" && specifier.exported.type === "Identifier" && specifier.exported.name === exportName && specifier.local.type === "Identifier") {
        exported = moduleScope.bindings.get(specifier.local.name)
      }
    }
  }
  const unwrap = (node: AstNode | null | undefined, seen = new Set<Binding>()): AstNode | undefined => {
    if (node?.type === "AssignmentPattern") {
      const value = unwrap(node.left, new Set(seen))
      return !node.left || (value?.type === "Literal" && value.value === undefined) ? unwrap(node.right, seen) : value
    }
    if (node?.type === "Identifier" && node.name !== undefined) {
      const declaration = bindingFor(node)
      if (!declaration) return node.name === "undefined" ? { type: "Literal", value: undefined } : undefined
      let init = parameterValues.has(declaration) ? parameterValues.get(declaration) : declaration.init
      for (const write of declaration.writes ?? []) {
        const state = writeState(write)
        if (write.node.left?.type === "Identifier" && state !== "skip") init = state === "known" && write.node.operator === "=" ? write.node.right : undefined
      }
      if (!init) return undefined
      if (seen.has(declaration)) throw new TypeError(`[vitehub] Circular Collection options in ${file}.`)
      seen.add(declaration)
      return unwrap(init, seen)
    }
    if (node?.type === "UnaryExpression" && node.operator === "!") {
      const value = unwrap(node.argument, new Set(seen))
      return value?.type === "Literal" ? { type: "Literal", value: !Boolean(value.value) } : node
    }
    if (node?.type === "UnaryExpression" && node.operator === "void") return { type: "Literal", value: undefined }
    if (node && ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression"].includes(node.type ?? "")) return unwrap(node.expression, seen)
    if (node?.type === "MemberExpression") {
      const object = unwrap(node.object, seen)
      const key = node.computed ? staticString(node.property) : node.property?.name
      if (object?.type !== "ObjectExpression" || key === undefined) return undefined
      let result: AstNode | undefined = { type: "Literal", value: undefined }
      for (const property of object.properties ?? []) {
        if (property.type === "SpreadElement") return undefined
        const name = property.computed ? staticString(property.key) : property.key?.name ?? property.key?.value
        if (name === key) {
          // SAFETY: ESTree object property values are expression nodes.
          result = unwrap(property.value as AstNode, new Set(seen))
        }
      }
      return result
    }
    return node ?? undefined
  }
  const writeState = (write: Write): "skip" | "known" | "unknown" => {
    // A completed helper may have used parameters or closed-over state that is
    // no longer available here. Its writes must not establish a public route.
    if (write.fn && !activeFunctions.has(write.fn)) {
      if ((write.node.start ?? Infinity) >= readPosition) return "skip"
      if (!executedFunctions.has(write.fn)) return "skip"
      const right = unwrap(write.node.right)
      if (right?.type === "Literal" && (right.value === undefined || right.value === true || right.value === false)) return "known"
      return "unknown"
    }
    if ((write.node.start ?? Infinity) >= readPosition) return "skip"
    const previousPosition = readPosition
    readPosition = write.node.start ?? readPosition
    let state: "known" | "unknown" = "known"
    for (const guard of write.guards) {
      readPosition = guard.test?.start ?? write.node.start ?? readPosition
      const test = unwrap(guard.test)
      if (test?.type !== "Literal") state = "unknown"
      else if (Boolean(test.value) !== guard.truthy) {
        readPosition = previousPosition
        return "skip"
      }
    }
    readPosition = previousPosition
    return state
  }
  const staticString = (node: AstNode | null | undefined, seen = new Set<Binding>()): string | undefined => {
    const value = unwrap(node, seen)
    if (!value) return undefined
    if (value.type === "Literal" && String(value.value) === value.value) return value.value
    if (value.type === "TemplateLiteral") {
      const quasis = value.quasis ?? []
      const expressions = value.expressions ?? []
      if (quasis.length !== expressions.length + 1) return undefined
      let result = ""
      for (let index = 0; index < quasis.length; index++) {
        result += quasis[index]?.value?.cooked ?? quasis[index]?.value?.raw ?? ""
        if (index < expressions.length) {
          const expression = staticString(expressions[index], new Set(seen))
          if (expression === undefined) return undefined
          result += expression
        }
      }
      return result
    }
    if (value.type === "BinaryExpression" && value.operator === "+") {
      const left = staticString(value.left, new Set(seen))
      const right = staticString(value.right, new Set(seen))
      return left !== undefined && right !== undefined ? left + right : undefined
    }
    return undefined
  }
  type RouteState = { present: boolean, value?: boolean }
  const routeValue = (value: AstNode | undefined): RouteState => {
    if (value?.type === "Literal" && (value.value === true || value.value === false)) return { present: true, value: value.value }
    if (value?.type === "Literal" && value.value === undefined) return { present: true, value: true }
    // An explicitly configured but unresolved route might be false. Do not expose it.
    return { present: true, value: value?.type === "Literal" ? true : false }
  }
  const staticObjectRoute = (node: AstNode | null | undefined, seen = new Set<Binding>()): RouteState | undefined => {
    if (node?.type === "CallExpression" && node.callee?.type === "MemberExpression" && !node.callee.computed && node.callee.object?.type === "Identifier" && node.callee.object.name === "Object" && node.callee.property?.name === "assign") {
      let merged: RouteState = { present: false }
      for (const argument of node.arguments ?? []) {
        const current = staticObjectRoute(argument, new Set(seen))
        if (current?.present) merged = current
        else merged = { present: true, value: false }
      }
      return merged
    }
    const object = unwrap(node, seen)
    if (object?.type !== "ObjectExpression") return undefined
    let route: RouteState = { present: false }
    for (const property of object.properties ?? []) {
      if (property.type === "SpreadElement") {
        const spreadRoute = staticObjectRoute(property.argument, new Set(seen))
        // An unresolved spread may overwrite route at runtime. Keep the
        // route decision conservative unless a later explicit property wins.
        if (spreadRoute?.present) route = spreadRoute
        else route = { present: true, value: false }
        continue
      }
      const keyName = property.computed ? staticString(property.key) : property.key?.name ?? property.key?.value
      if (keyName !== "route") continue
      // SAFETY: ESTree property values are expression nodes; this narrow view only reads their common shape.
      const value = unwrap(property.value as AstNode | null | undefined)
      route = routeValue(value)
    }
    if (node?.type === "Identifier") for (const write of bindingFor(node)?.writes ?? []) {
      const state = writeState(write)
      if (write.node.left?.type !== "MemberExpression" || state === "skip") continue
      const key = write.node.left.computed ? staticString(write.node.left.property) : write.node.left.property?.name
      if (key === "route") {
        if (write.node.type === "UnaryExpression") route = { present: true, value: true }
        else route = routeValue(state === "known" && write.node.operator === "=" ? unwrap(write.node.right) : undefined)
      }
    }
    if (node?.type === "Identifier") {
      const init = bindingFor(node)?.init
      if (init?.type === "Identifier") {
        for (const write of bindingFor(init)?.writes ?? []) {
          const state = writeState(write)
          if (write.node.left?.type !== "MemberExpression" || state === "skip") continue
          const key = write.node.left.computed ? staticString(write.node.left.property) : write.node.left.property?.name
          if (key === "route") route = write.node.type === "UnaryExpression" ? { present: true, value: true } : routeValue(state === "known" ? unwrap(write.node.right) : undefined)
        }
      }
    }
    if (node?.type === "Identifier") {
      const alias = unwrap(node)
      if (alias && alias !== node && alias.type === "Identifier") {
        for (const write of bindingFor(alias)?.writes ?? []) {
          const state = writeState(write)
          if (write.node.left?.type === "MemberExpression" && state !== "skip") {
            const key = write.node.left.computed ? staticString(write.node.left.property) : write.node.left.property?.name
            if (key === "route") route = write.node.type === "UnaryExpression" ? { present: true, value: true } : routeValue(state === "known" ? unwrap(write.node.right) : undefined)
          }
        }
      }
    }
    if (route.present) routeEffectState = route.value !== false
    return route
  }
  const routeWritesFor = (functions: Set<AstNode>): Write[] => {
    const writes: Write[] = []
    for (const write of indexedWrites) if (write.fn && functions.has(write.fn)) {
          const left = write.node.left
          const key = left?.type === "MemberExpression"
            ? (left.computed ? staticString(left.property) : left.property?.name)
            : undefined
      if (key === "route") writes.push(write)
    }
    return writes
  }
  const branchRouteEffect = (functions: Set<AstNode>): boolean | undefined => {
    const writes = routeWritesFor(functions)
    // Distinct helpers can establish the same route state. Compare their
    // resolved writes rather than their AST identities so an unresolved
    // conditional retains a guaranteed `route: false` effect.
    const values = writes
      .map(write => write.node.type === "UnaryExpression" ? true : unwrap(write.node.right))
      .map(value => value === true ? true : value?.type === "Literal" ? value.value : undefined)
    if (values.some(value => value === false)) return false
    if (values.some(value => value === true || value === undefined)) return true
    return undefined
  }
  const findRoute = (node: AstNode | null | undefined, active = new Set<AstNode>()): boolean | undefined => {
    const value = unwrap(node)
    if (!value || active.has(value)) return undefined
    const next = new Set(active).add(value)
    if (value.type === "ConditionalExpression") {
      const test = unwrap(value.test)
      if (test?.type === "Literal") return findRoute(test.value ? value.consequent : value.alternate, next)
      // An unresolved conditional executes only one branch at runtime. Keep
      // helper activation, parameter bindings, and writes from either branch
      // isolated so a helper visited in the consequent cannot affect the
      // alternate (or subsequent route inspection).
      const branchSnapshot = snapshotExecution()
      routeEffectState = undefined
      const consequent = findRoute(value.consequent, new Set(next))
      const consequentState = snapshotExecution()
      const consequentEffect = consequentState.routeEffectState
      restoreExecution(branchSnapshot)
      routeEffectState = undefined
      const alternate = findRoute(value.alternate, new Set(next))
      const alternateState = snapshotExecution()
      const alternateEffect = alternateState.routeEffectState
      restoreExecution(branchSnapshot)
      // Effects that occur in both branches are guaranteed at runtime and
      // must remain visible to route inspection after the conditional.
      for (const fn of consequentState.executedFunctions) {
        if (alternateState.executedFunctions.has(fn)) executedFunctions.add(fn)
      }
      const consequentBranchEffect = consequentEffect ?? branchRouteEffect(consequentState.executedFunctions)
      const alternateBranchEffect = alternateEffect ?? branchRouteEffect(alternateState.executedFunctions)
      if (consequentBranchEffect === false && alternateBranchEffect === false) {
        for (const fn of [...consequentState.executedFunctions, ...alternateState.executedFunctions]) {
          if (routeWritesFor(new Set([fn])).length > 0) executedFunctions.add(fn)
        }
        routeEffectState = false
        return false
      }
      if (consequent !== undefined && consequent === alternate) return consequent
      if (consequentEffect !== undefined && consequentEffect === alternateEffect) {
        routeEffectState = consequentEffect
        return consequentEffect
      }
      return undefined
    }
    if (value.type === "IfStatement") {
      const test = unwrap(value.test)
      if (test?.type === "Literal") return findRoute(test.value ? value.consequent : value.alternate, next)
      const branchSnapshot = snapshotExecution()
      routeEffectState = undefined
      const consequent = findRoute(value.consequent, new Set(next))
      const consequentState = snapshotExecution()
      const consequentEffect = consequentState.routeEffectState ?? branchRouteEffect(consequentState.executedFunctions)
      restoreExecution(branchSnapshot)
      routeEffectState = undefined
      const alternate = value.alternate ? findRoute(value.alternate, new Set(next)) : undefined
      const alternateState = snapshotExecution()
      const alternateEffect = alternateState.routeEffectState ?? branchRouteEffect(alternateState.executedFunctions)
      restoreExecution(branchSnapshot)
      if (consequentEffect === false && alternateEffect === false) {
        // Both branches establish the same server-only route state, even when
        // they call different helper functions. Preserve those route-relevant
        // helpers after restoring the pre-branch execution snapshot so the
        // later Collection options inspection can observe their writes.
        for (const fn of [...consequentState.executedFunctions, ...alternateState.executedFunctions]) {
          if (routeWritesFor(new Set([fn])).length > 0) executedFunctions.add(fn)
        }
        routeEffectState = false
      }
      else if (consequentEffect !== undefined && consequentEffect === alternateEffect) routeEffectState = consequentEffect
      return consequent !== undefined && alternate !== undefined && consequent === alternate
        ? consequent
        : consequentEffect !== undefined && consequentEffect === alternateEffect
          ? consequentEffect
          : undefined
    }
    if (value.type === "ExpressionStatement") return findRoute(value.expression, next)
    if (value.type === "VariableDeclaration") {
      let result: boolean | undefined
      for (const declaration of value.declarations ?? []) {
        if (!declaration.init) continue
        const candidate = findRoute(declaration.init, next)
        if (candidate !== undefined) result = candidate
      }
      return result
    }
    if (value.type === "ObjectExpression") {
      const route = staticObjectRoute(value)
      return route?.value !== false
    }
    if (value.type === "CallExpression") {
      const args = value.arguments ?? []
      const callee = value.callee ?? value.expression
      const isCollectionCall = unwrap(callee)?.type === "CollectionFactory" || (callee?.type === "Identifier" && callee.name === "defineCollection" && !bindingFor(callee))
      const isNamespaceCollectionCall = callee?.type === "MemberExpression" && unwrap(callee.object)?.type === "CollectionNamespace" && (callee.computed ? staticString(callee.property) : callee.property?.name) === "defineCollection"
      if (isCollectionCall || isNamespaceCollectionCall) {
        const previousPosition = readPosition
        readPosition = value.start ?? readPosition
        const route = staticObjectRoute(args.length > 1 ? args[1] : args[0])
        readPosition = previousPosition
        return route?.value !== false
      }
      // Common transparent wrappers preserve the Collection value and its
      // route metadata. Inspect their argument without importing application
      // modules (which may have side effects during generation).
      if (callee?.type === "MemberExpression" && !callee.computed && callee.object?.type === "Identifier" && callee.object.name === "Object" && callee.property?.name === "freeze") {
        return findRoute(args[0], next)
      }
      const fn = unwrap(callee)
      if (!fn || !["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(fn.type ?? "")) return undefined
      const previousValues = new Map(parameterValues)
      for (const [index, param] of (fn.params ?? []).entries()) {
        const binding = bindingFor(param.type === "AssignmentPattern" ? param.left! : param)
        if (!binding) continue
        const argument = args[index]
        const value = unwrap(argument)
        if (argument && !(value?.type === "Literal" && value.value === undefined && param.type === "AssignmentPattern")) parameterValues.set(binding, argument)
        else if (param.type === "AssignmentPattern") parameterValues.delete(binding)
        else parameterValues.set(binding, { type: "Literal", value: undefined })
      }
      activeFunctions.add(fn)
      executedFunctions.add(fn)
      const result = findRoute(Array.isArray(fn.body) ? undefined : fn.body, next)
      activeFunctions.delete(fn)
      parameterValues.clear()
      for (const [binding, argument] of previousValues) parameterValues.set(binding, argument)
      return result
    }
    if (value.type === "BlockStatement") {
      const hasReturn = (candidate: AstNode | null | undefined): boolean => {
        if (!candidate) return false
        if (candidate.type === "ReturnStatement") return true
        for (const child of Object.values(candidate)) {
          if (Array.isArray(child)) {
            if (child.some(item => item && typeof item === "object" && hasReturn(item as AstNode))) return true
          }
          else if (child && typeof child === "object" && hasReturn(child as AstNode)) return true
        }
        return false
      }
      for (const statement of Array.isArray(value.body) ? value.body : []) {
        if (statement.type === "ReturnStatement") return findRoute(statement.argument ?? statement.expression, next)
        if (statement.type === "IfStatement") {
          const result = findRoute(statement, next)
          if (result !== undefined) return result
          // An unresolved branch that can return a Collection means a later
          // return is only conditionally reached. Do not select it as the
          // exported value when the branch's route is unknown.
          if (hasReturn(statement.consequent) || hasReturn(statement.alternate)) return undefined
          continue
        }
        if (statement.type === "ExpressionStatement" && statement.expression) findRoute(statement.expression, next)
        if (statement.type === "VariableDeclaration") {
          for (const declaration of statement.declarations ?? []) if (declaration.init) findRoute(declaration.init, next)
        }
        // Non-returning control flow cannot itself supply the exported Collection.
        // Continue scanning so an unconditional return that follows it is still
        // inspected (the runtime reaches that return when the control flow ends).
      }
    }
    return undefined
  }
  // Module-scope calls execute before exported initializers and may mutate
  // option objects consumed by the Collection. Replay those calls so their
  // statically known route effects are visible without importing the module.
  const exportStart = exported?.init?.start ?? Infinity
  for (const statement of parsed.program.body) {
    if ((statement.start ?? Infinity) >= exportStart) continue
    // Replay all executable module setup, including statically resolvable
    // control-flow statements that can call route-mutating helpers.
    findRoute(statement as AstNode)
  }
  return findRoute(exported?.init) ?? true
}

async function discoverCollections(options: SourceGenerationOptions): Promise<DiscoveredCollection[]> {
  const serverDirs = options.serverDirs === undefined
    ? [resolve(options.projectRoot, "server")]
    : options.serverDirs.map(directory => resolve(options.projectRoot, directory))
  const collections = (await Promise.all(serverDirs.map(async (serverDir) => {
    const directory = resolve(serverDir, "collections")
    return await Promise.all((await collectCollectionFiles(directory)).sort().map(async (file) => {
      const extension = extname(file)
      const exportName = basename(file, extension)
      if (!/^[A-Z_$][\w$]*$/i.test(exportName)) {
        throw sourceErrorDiagnostics.SOURCE_B0003({ message: `[vitehub] Collection file ${JSON.stringify(relative(options.projectRoot, file))} must use a valid JavaScript identifier as its filename.` })
      }
      const name = relative(directory, file).slice(0, -extension.length).replaceAll("\\", "/")
      const source = await readFile(file, "utf8")
      if (!findExportNames(source).includes(exportName)) {
        throw sourceErrorDiagnostics.SOURCE_B0004({ message: `[vitehub] Collection file ${JSON.stringify(relative(options.projectRoot, file))} must export a Collection named ${JSON.stringify(exportName)} to match its filename.` })
      }
      return { exportName, file, name, routeEnabled: collectionRouteEnabled(file, source, exportName) }
    }))
  }))).flat().sort((left, right) => left.name.localeCompare(right.name))

  const generatedPaths = new Map<string, DiscoveredCollection>()
  for (const collection of collections) {
    const generatedPath = `${collection.name}.mjs`.toLowerCase()
    const previous = generatedPaths.get(generatedPath)
    if (previous?.name === collection.name) {
      throw sourceErrorDiagnostics.SOURCE_B0005({ message: `[vitehub] Collection name ${JSON.stringify(collection.name)} is defined in more than one server directory.` })
    }
    if (previous) {
      const [firstName, secondName] = [previous.name, collection.name].sort()
      throw sourceErrorDiagnostics.SOURCE_B0006({ message: `[vitehub] Collection names ${JSON.stringify(firstName)} and ${JSON.stringify(secondName)} generate the same route module on case-insensitive filesystems.` })
    }
    generatedPaths.set(generatedPath, collection)
  }
  return collections
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
  const packageOutput = resolve(options.projectRoot, collectionTypesPackageEntry)
  const routesDirectory = resolve(options.projectRoot, collectionRoutesDirectory)
  if (collections.length === 0) {
    await Promise.all([
      rm(output, { force: true }),
      rm(packageOutput, { force: true }),
      rm(routesDirectory, { force: true, recursive: true }),
    ])
    return []
  }

  const routedCollections = collections.filter(collection => collection.routeEnabled)
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
  await writeFileIfChanged(packageOutput, '/// <reference path="./collections.d.ts" />\n')

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

async function discoverContent(options: SourceGenerationOptions): Promise<string | undefined> {
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
  if (!findExportNames(await readFile(file, "utf8")).includes("content")) {
    throw sourceErrorDiagnostics.SOURCE_B0008({ message: `[vitehub] Content file ${JSON.stringify(relative(options.projectRoot, file))} must export a Comark Content instance named "content".` })
  }
  return file
}

async function writeContentArtifact(
  options: SourceGenerationOptions,
  file: string | undefined,
): Promise<GeneratedSourceHandler[]> {
  const output = resolve(options.projectRoot, contentRouteEntry)
  const preview = resolve(options.projectRoot, contentPreviewEntry)
  if (!file) {
    await Promise.all([rm(output, { force: true }), rm(preview, { force: true })])
    return []
  }
  const importBase = JSON.stringify(options.contentImportBase ?? "@vite-hub/content")
  const contentModule = JSON.stringify(toRuntimeModuleSpecifier(file))
  await writeFileIfChanged(output, [
    `import { defineContentHandler } from ${importBase}`,
    `import { content } from ${contentModule}`,
    "",
    "export default defineContentHandler(content)",
    "",
  ].join("\n"))
  // A Nitro plugin: scopes each request that carries the Content preview cookie to drafts and out of Nitro's cache.
  await writeFileIfChanged(preview, [
    `import { defineContentPreviewPlugin } from ${importBase}`,
    `import { content } from ${contentModule}`,
    "",
    "export default defineContentPreviewPlugin(content)",
    "",
  ].join("\n"))
  return [{ handler: preview, plugin: true }, { handler: output, route: "/api/content/**" }]
}

export async function prepareSourceGeneration(options: SourceGenerationOptions): Promise<GeneratedSourceHandler[]> {
  const [collections, content] = await Promise.all([
    discoverCollections(options),
    discoverContent(options),
  ])
  return [
    ...await writeCollectionArtifacts(options, collections),
    ...await writeContentArtifact(options, content),
  // Plugins have no route and sort first.
  ].sort((left, right) => (left.route ?? "").localeCompare(right.route ?? ""))
}

function applicationBaseURL(base: string | undefined): string {
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
  const plugins = merged.plugins?.slice(Array.isArray(existing.plugins) ? existing.plugins.length : 0)
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
    onGeneratedHandlersChanged: (
      listener: GeneratedSourceHandlersListener,
      options?: GeneratedSourceHandlersListenerOptions,
    ) => () => void
    prepareSources: (options: Omit<SourceGenerationOptions, "auth" | "contentImportBase" | "importBase">) => Promise<GeneratedSourceHandler[]>
  }
  nitro: { name: string, setup(nitro: SourceNitroHost): void }
  vitehub: ViteHubInspectionPluginMetadata
} {
  const refreshAuthByRoot = new Map<string, () => unknown>()
  let nitroHost: SourceNitroHost | undefined
  let nitroHostContribution: NitroGeneratedConfig | undefined
  const nitroHandlers: GeneratedSourceHandler[] = []
  let latestProjectRoot: string | undefined
  const configuredStateByRoot = new Map<string, {
    configuredAuth?: boolean
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
  const configurationTransitionByRoot = new Map<string, Promise<unknown>>()
  const generatedHandlersListeners = new Set<{
    handlesHostRestart?: boolean
    listener: GeneratedSourceHandlersListener
    projectRoot?: string
  }>()
  const prepareSources = (
    input: Omit<SourceGenerationOptions, "auth" | "contentImportBase" | "importBase">,
    configuredAuth?: boolean,
  ) => {
    const root = resolve(input.projectRoot)
    const previousPreparation = sourcePreparationByRoot.get(root) ?? Promise.resolve()
    const runPreparation = () => {
      const configuredState = configuredStateByRoot.get(root)
      const resolvedConfiguredAuth = configuredAuth === undefined
        ? configuredState?.configuredAuth
        : configuredAuth
      const auth = typeof options.auth === "function"
        ? options.auth({ configuredAuth: resolvedConfiguredAuth, projectRoot: root, serverDirs: input.serverDirs })
        : options.auth && resolvedConfiguredAuth !== false && Boolean(refreshAuthByRoot.get(root)?.())
      return prepareSourceGeneration({
        ...input,
        auth,
        importBase: options.importBase,
        contentImportBase: options.contentImportBase,
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
    api: { onGeneratedHandlersChanged, prepareSources },
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
      setup(nitro) {
        nitroHost = nitro
        nitroHostContribution = undefined
        generatedRouteGuard(nitroHandlers).setup(nitro)
      },
    },
    async config(config) {
      // SAFETY: Vite passes its user config with ViteHub's shared symbols attached.
      const viteConfig = config as SourcePluginConfig
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) return
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
          const handlers = await prepareSources({ projectRoot, serverDirs }, viteConfig.auth === false ? false : viteConfig.auth ? true : undefined)
          const handlerKey = await generatedHandlerKey(handlers)
          const nitro = generatedSourceNitroContribution(viteConfig.nitro, handlers)
          configuredStateByRoot.set(projectRoot, {
            configuredAuth: viteConfig.auth === false ? false : viteConfig.auth ? true : undefined,
            handlerKey,
            nitroContribution: nitro,
            serverDirs: serverDirs?.slice(),
          })
          const contribution: SourcePluginConfig = {
            define: { __VITEHUB_APP_BASE_URL__: JSON.stringify(applicationBaseURL(viteConfig.base)) },
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
      return transition
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
      viteConfig.define.__VITEHUB_APP_BASE_URL__ = JSON.stringify(applicationBaseURL(config.base))
      const previousTransition = configurationTransitionByRoot.get(projectRoot) ?? Promise.resolve()
      const runTransition = async () => {
        const configuredState = configuredStateByRoot.get(projectRoot)
        const serverDirs = viteConfig[VITEHUB_SERVER_DIRS] ?? configuredState?.serverDirs
        const handlers = await prepareSources({ projectRoot, serverDirs }, viteConfig.auth === false ? false : viteConfig.auth ? true : undefined)
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
          nitroHost.routing.sync()
        }
        configuredStateByRoot.set(projectRoot, {
          configuredAuth: viteConfig.auth === false ? false : viteConfig.auth ? true : undefined,
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
