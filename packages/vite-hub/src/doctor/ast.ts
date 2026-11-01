import * as v from "valibot"
import type { RuleContext } from "vite-doctor/extension"

import { viteHubInventory } from "./inventory.ts"

/** A script AST node from oxc-parser. */
export type AstNode = { type: string, [key: string]: unknown }
type Identifier = { type: "Identifier", name: string }

const astNodeSchema = v.looseObject({ type: v.string() })
const identifierSchema = v.object({ type: v.literal("Identifier"), name: v.string() })
const stringLiteralSchema = v.object({ type: v.literal("Literal"), value: v.string() })
const templateValueSchema = v.object({ cooked: v.string() })
const wrapperSchema = v.object({
  type: v.picklist(["ParenthesizedExpression", "TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "TSTypeAssertion", "ChainExpression"]),
  expression: v.unknown(),
})
const moduleSourceSchema = v.object({
  type: v.picklist(["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"]),
  source: v.object({ value: v.string() }),
  importKind: v.optional(v.string()),
  exportKind: v.optional(v.string()),
  specifiers: v.optional(v.array(v.object({
    importKind: v.optional(v.string()),
    exportKind: v.optional(v.string()),
  }))),
})
const importDeclarationSchema = v.object({
  type: v.literal("ImportDeclaration"),
  importKind: v.optional(v.string()),
  source: v.object({ value: v.string() }),
  specifiers: v.array(v.object({
    type: v.string(),
    importKind: v.optional(v.string()),
    imported: v.optional(v.object({ type: v.string(), name: v.optional(v.string()), value: v.optional(v.string()) })),
    local: identifierSchema,
  })),
})

export function isNode(value: unknown): value is AstNode {
  return v.is(astNodeSchema, value)
}

export function isNodeType<T extends string>(value: unknown, type: T): value is AstNode & { type: T } {
  return isNode(value) && value.type === type
}

export function isIdentifier(value: unknown, name?: string): value is Identifier {
  return v.is(identifierSchema, value) && (name === undefined || value.name === name)
}

/** Removes parentheses, type assertions, `!`, and optional chains around an expression. */
export function unwrap(node: unknown): unknown {
  return v.is(wrapperSchema, node) ? unwrap(node.expression) : node
}

// Doctor links parents as `parent` in current releases and as `__doctorParent` in earlier ones.
// `buildScopes()` records them too, so a parent is known for every node in an indexed file.
const parents = new WeakMap<object, AstNode>()

export function parentOf(node: unknown): AstNode | undefined {
  if (!isNode(node)) return
  if (isNode(node.parent)) return node.parent
  const linked: unknown = Reflect.get(node, "__doctorParent")
  return isNode(linked) ? linked : parents.get(node)
}

/** Returns the first parent that is not a wrapper from `unwrap()`. */
export function semanticParent(node: unknown): { parent: AstNode | undefined, child: unknown } {
  let child = node
  let parent = parentOf(node)
  while (parent && v.is(wrapperSchema, parent)) {
    child = parent
    parent = parentOf(parent)
  }
  return { parent, child }
}

export function stringValue(node: unknown): string | undefined {
  const target = unwrap(node)
  if (v.is(stringLiteralSchema, target)) return target.value
  if (isNodeType(target, "TemplateLiteral") && Array.isArray(target.expressions) && target.expressions.length === 0
    && Array.isArray(target.quasis) && target.quasis.length === 1) {
    const quasi = target.quasis[0]
    // A template element's `value` is `{ raw, cooked }`, which has no `type`.
    if (isNode(quasi) && v.is(templateValueSchema, quasi.value)) return quasi.value.cooked
  }
}

export function numberValue(node: unknown): number | undefined {
  const target = unwrap(node)
  if (isNodeType(target, "Literal") && typeof target.value === "number") return target.value
  if (isNodeType(target, "UnaryExpression") && target.operator === "-") {
    const value = numberValue(target.argument)
    return value === undefined ? undefined : -value
  }
}

export function booleanValue(node: unknown): boolean | undefined {
  const target = unwrap(node)
  if (isNodeType(target, "Literal") && typeof target.value === "boolean") return target.value
}

/** The static name of a property key: `a`, `"a"`, or `["a"]`. */
export function propertyName(property: AstNode): string | undefined {
  if (property.type !== "Property" && property.type !== "PropertyDefinition" && property.type !== "MethodDefinition") return
  if (property.computed !== true && isIdentifier(property.key)) return property.key.name
  return stringValue(property.key)
}

/** The properties of an object literal, including spreads, in source order. */
export function objectProperties(node: unknown): AstNode[] {
  const target = unwrap(node)
  if (!isNodeType(target, "ObjectExpression") || !Array.isArray(target.properties)) return []
  return target.properties.filter(isNode)
}

export function objectProperty(node: unknown, name: string): AstNode | undefined {
  return objectProperties(node).findLast(property => propertyName(property) === name)
}

export function objectValue(node: unknown, name: string): unknown {
  return objectProperty(node, name)?.value
}

export function callArguments(node: unknown): unknown[] {
  const target = unwrap(node)
  return (isNodeType(target, "CallExpression") || isNodeType(target, "NewExpression")) && Array.isArray(target.arguments) ? target.arguments : []
}

/** Static member path of an expression, such as `["blob", "media", "put"]` for `blob.media.put`. */
export function memberPath(node: unknown): string[] | undefined {
  const target = unwrap(node)
  if (isIdentifier(target)) return [target.name]
  if (!isNodeType(target, "MemberExpression")) return
  const object = memberPath(target.object)
  if (!object) return
  const property = target.computed === true ? stringValue(target.property) : isIdentifier(target.property) ? target.property.name : undefined
  return property === undefined ? undefined : [...object, property]
}

/** The innermost Identifier at the root of a member chain or call chain: `kv` in `kv.store("a").get`. */
export function chainRoot(node: unknown): Identifier | undefined {
  const target = unwrap(node)
  if (isIdentifier(target)) return target
  if (isNodeType(target, "MemberExpression")) return chainRoot(target.object)
  if (isNodeType(target, "CallExpression")) return chainRoot(target.callee)
}

export function moduleSpecifier(node: unknown): { specifier: string, typeOnly: boolean } | undefined {
  if (!v.is(moduleSourceSchema, node)) return
  const specifiers = node.specifiers ?? []
  return {
    specifier: node.source.value,
    typeOnly: node.importKind === "type" || node.exportKind === "type"
      || (specifiers.length > 0 && specifiers.every(specifier => specifier.importKind === "type" || specifier.exportKind === "type")),
  }
}

/**
 * Maps a ViteHub import path to one name for the owner package and the `vite-hub` facade:
 * `vite-hub/queue` and `@vite-hub/queue` both return `queue`.
 */
export function vitehubModule(specifier: string): string | undefined {
  const match = /^(?:vite-hub|@vite-hub)\/(.+)$/.exec(specifier)
  return match?.[1]
}

export function isFunctionNode(node: unknown): boolean {
  return isNode(node) && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
}

/** The nearest enclosing function, or `undefined` when the node runs at module scope. */
export function enclosingFunction(node: unknown): AstNode | undefined {
  let current = parentOf(node)
  while (current) {
    if (isFunctionNode(current)) return current
    // An instance field runs when an object is created, not when the module loads.
    if (current.type === "MethodDefinition" || current.type === "PropertyDefinition" && current.static !== true) return current
    current = parentOf(current)
  }
}

// Scope index.

export type ImportOrigin = { source: string, name: string }
export type Binding = { origin?: ImportOrigin, init?: unknown, declaration?: AstNode }
type Scope = { parent?: Scope, functionScope: boolean, bindings: Map<string, Binding> }

function namespaceIdentifier(node: unknown): Identifier | undefined {
  if (isIdentifier(node)) return node
  if (isNodeType(node, "TSQualifiedName")) return namespaceIdentifier(node.left)
}

// Empty and type-only namespaces are erased, including nested namespace bodies.
function instantiatesNamespace(node: unknown): boolean {
  if (!isNode(node) || node.declare === true) return false
  switch (node.type) {
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSImportEqualsDeclaration":
      return false
    case "TSModuleDeclaration":
      return Boolean(namespaceIdentifier(node.id)) && instantiatesNamespace(node.body)
    case "TSModuleBlock":
      return Array.isArray(node.body) && node.body.some(instantiatesNamespace)
    case "ExportNamedDeclaration":
      // Only exported import aliases instantiate a namespace.
      if (isNodeType(node.declaration, "TSImportEqualsDeclaration")) {
        return node.exportKind !== "type" && node.declaration.importKind !== "type"
      }
      return node.exportKind !== "type" && (node.declaration
        ? instantiatesNamespace(node.declaration)
        : Array.isArray(node.specifiers) && node.specifiers.some(specifier => isNode(specifier) && specifier.exportKind !== "type"))
    default:
      return true
  }
}

const scopeCreatingTypes = new Set(["BlockStatement", "CatchClause", "ForStatement", "ForInStatement", "ForOfStatement", "SwitchStatement", "ClassDeclaration", "ClassExpression", "StaticBlock"])

/** Collects bindings for every scope first, so a use can resolve to a declaration later in its scope. */
function buildScopes(root: unknown): WeakMap<object, Scope> {
  const scopes = new WeakMap<object, Scope>()
  const rootScope: Scope = { functionScope: true, bindings: new Map() }

  function bind(pattern: unknown, scope: Scope, binding: Binding = {}) {
    if (!isNode(pattern)) return
    // A name inside a pattern keeps its declarator, but not the initializer, which belongs to the whole pattern.
    const inner: Binding = binding.declaration ? { declaration: binding.declaration } : {}
    switch (pattern.type) {
      case "Identifier":
        if (isIdentifier(pattern)) scope.bindings.set(pattern.name, binding)
        break
      case "RestElement": bind(pattern.argument, scope, inner); break
      case "AssignmentPattern": bind(pattern.left, scope, inner); break
      case "ArrayPattern":
        if (Array.isArray(pattern.elements)) for (const element of pattern.elements) bind(element, scope, inner)
        break
      case "ObjectPattern":
        if (Array.isArray(pattern.properties)) {
          for (const property of pattern.properties) {
            if (isNode(property)) bind(property.type === "RestElement" ? property.argument : property.value, scope, inner)
          }
        }
        break
    }
  }

  function walk(node: unknown, enclosing: Scope, parent?: AstNode, ambient = false) {
    if (!isNode(node)) return
    if (parent) parents.set(node, parent)
    ambient ||= node.declare === true || (node.type === "TSModuleDeclaration" && !namespaceIdentifier(node.id))
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") bind(node.id, enclosing, { declaration: node })
    // Any runtime declaration in a merge binds the name; erased declarations leave it intact.
    if (node.type === "TSModuleDeclaration" && !ambient && instantiatesNamespace(node)) bind(namespaceIdentifier(node.id), enclosing)
    const isFunction = isFunctionNode(node)
    const isModule = node.type === "TSModuleDeclaration" || node.type === "TSModuleBlock"
    const createsScope = isFunction || isModule || scopeCreatingTypes.has(node.type)
    // Namespace and module bodies also contain `var` declarations; they must not hoist out.
    const scope = createsScope ? { parent: enclosing, functionScope: isFunction || isModule || node.type === "StaticBlock", bindings: new Map<string, Binding>() } : enclosing
    scopes.set(node, scope)
    if (isFunction) {
      if (node.type === "FunctionExpression") bind(node.id, scope)
      if (Array.isArray(node.params)) for (const param of node.params) bind(param, scope)
    }
    if (node.type === "ClassExpression" || node.type === "ClassDeclaration") bind(node.id, scope)
    if (node.type === "CatchClause") bind(node.param, scope)
    if (v.is(importDeclarationSchema, node)) {
      for (const specifier of node.specifiers) {
        const name = specifier.type === "ImportDefaultSpecifier" ? "default"
          : specifier.type === "ImportNamespaceSpecifier" ? "*"
            : specifier.imported?.name ?? specifier.imported?.value ?? specifier.local.name
        bind(specifier.local, scope, { origin: { source: node.source.value, name }, declaration: node })
      }
    }
    if (node.type === "VariableDeclarator") {
      let target = scope
      if (parent?.kind === "var") while (!target.functionScope && target.parent) target = target.parent
      bind(node.id, target, { init: node.init, declaration: node })
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue
      if (Array.isArray(value)) for (const child of value) walk(child, scope, node, ambient)
      else walk(value, scope, node, ambient)
    }
  }
  walk(root, rootScope)
  return scopes
}

export type ScopeIndex = {
  /** The binding that a name resolves to at `node`, or `undefined` for a global or auto-import. */
  lookup(node: AstNode, name: string): Binding | undefined
}

const scopeIndexes = new WeakMap<object, ScopeIndex>()

export function scopeIndex(ctx: RuleContext): ScopeIndex {
  const root = ctx.file.scriptAst
  if (!root) return { lookup: () => undefined }
  const cached = scopeIndexes.get(root)
  if (cached) return cached
  const scopes = buildScopes(root)
  const index: ScopeIndex = {
    lookup(node, name) {
      let scope = scopes.get(node)
      while (scope) {
        const binding = scope.bindings.get(name)
        if (binding) return binding
        scope = scope.parent
      }
    },
  }
  scopeIndexes.set(root, index)
  return index
}

/** Auto-imports that `vite-hub/nuxt` registers for Nitro server code. */
const nuxtServerAutoImports = new Map<string, ImportOrigin>([
  ["kv", { source: "vite-hub/kv", name: "kv" }],
  ["blob", { source: "vite-hub/blob", name: "blob" }],
  ["db", { source: "vite-hub/database/drizzle", name: "db" }],
  ["schema", { source: "vite-hub/database/drizzle", name: "schema" }],
])

export function isServerFile(path: string): boolean {
  return /(?:^|\/)server\//.test(path)
}

export function isTestFile(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|fixtures?)\//.test(path) || /\.(?:test|spec|test-d)\.[^/]+$/.test(path)
}

/** A resolved ViteHub export: the module name from `vitehubModule()` and the export name. */
export type ViteHubReference = { module: string, name: string, path: string[] }

export type Resolver = {
  ctx: RuleContext
  scopes: ScopeIndex
  /** Resolves an identifier or member chain to the ViteHub export it reads, following `const` aliases. */
  reference(node: unknown): ViteHubReference | undefined
  /** Resolves the callee of a call or `new` expression. */
  callee(node: unknown): ViteHubReference | undefined
  /** The binding for an identifier at its use. */
  binding(node: unknown): Binding | undefined
}

const resolvers = new WeakMap<object, Resolver>()

export function resolver(ctx: RuleContext): Resolver {
  const root = ctx.file.scriptAst
  const cached = root ? resolvers.get(root) : undefined
  if (cached && cached.ctx.file.path === ctx.file.path) return cached
  const scopes = scopeIndex(ctx)
  const autoImports = ctx.project.framework === "nuxt" && isServerFile(ctx.file.relativePath) ? nuxtServerAutoImports : new Map<string, ImportOrigin>()

  function binding(node: unknown) {
    const target = unwrap(node)
    return isIdentifier(target) ? scopes.lookup(target, target.name) : undefined
  }

  function originOf(node: Identifier, seen: Set<Binding>): { origin: ImportOrigin, rest: string[] } | undefined {
    const found = scopes.lookup(node, node.name)
    if (!found) {
      const auto = autoImports.get(node.name)
      return auto ? { origin: auto, rest: [] } : undefined
    }
    if (found.origin) return { origin: found.origin, rest: [] }
    if (seen.has(found)) return
    seen.add(found)
    // Follow `const alias = kv` and `const alias = kv.media`, but not calls.
    const init = unwrap(found.init)
    if (!isNodeType(found.declaration, "VariableDeclarator") || !isIdentifier(found.declaration.id)) return
    const path = memberPath(init)
    const root = chainRoot(init)
    if (!path || !root || !isIdentifier(unwrap(init)) && !isNodeType(unwrap(init), "MemberExpression")) return
    const resolved = originOf(root, seen)
    return resolved && { origin: resolved.origin, rest: [...resolved.rest, ...path.slice(1)] }
  }

  function reference(node: unknown): ViteHubReference | undefined {
    const target = unwrap(node)
    const path = memberPath(target)
    const root = chainRoot(target)
    if (!path || !root) return
    const resolved = originOf(root, new Set())
    if (!resolved) return
    const module = vitehubModule(resolved.origin.source) ?? (resolved.origin.source.startsWith("#vitehub/") ? resolved.origin.source : undefined)
    if (!module) return
    const full = [...resolved.rest, ...path.slice(1)]
    if (resolved.origin.name === "*") {
      const [name, ...rest] = full
      return name ? { module, name, path: rest } : undefined
    }
    return { module, name: resolved.origin.name, path: full }
  }

  const result: Resolver = {
    ctx,
    scopes,
    reference,
    binding,
    callee(node) {
      const target = unwrap(node)
      if (!isNodeType(target, "CallExpression") && !isNodeType(target, "NewExpression")) return
      return reference(target.callee)
    },
  }
  if (root) resolvers.set(root, result)
  return result
}

/** True when `reference` is the export `name` of one of `modules`, with no member path. */
export function isExport(reference: ViteHubReference | undefined, modules: readonly string[], name: string | readonly string[]): boolean {
  if (!reference || reference.path.length > 0 || !modules.includes(reference.module)) return false
  return typeof name === "string" ? reference.name === name : name.includes(reference.name)
}

/** Visits every script node once, depth first. Use it inside `ScriptNode` only for the Program node. */
export function walkScript(root: unknown, visit: (node: AstNode) => void): void {
  if (!isNode(root)) return
  visit(root)
  for (const [key, value] of Object.entries(root)) {
    if (key === "parent") continue
    if (Array.isArray(value)) for (const child of value) walkScript(child, visit)
    else walkScript(value, visit)
  }
}

/** The `export default` value of a module, following `export default name` to its `const` initializer. */
export function defaultExport(ctx: RuleContext): { node: AstNode, value: unknown } | undefined {
  const program = ctx.file.scriptAst
  if (!isNode(program) || !Array.isArray(program.body)) return
  for (const statement of program.body) {
    if (isNodeType(statement, "ExportDefaultDeclaration")) {
      const declaration = unwrap(statement.declaration)
      if (isIdentifier(declaration)) {
        const found = scopeIndex(ctx).lookup(statement, declaration.name)
        return { node: statement, value: found?.init ?? found?.declaration ?? declaration }
      }
      return { node: statement, value: declaration }
    }
    if (isNodeType(statement, "ExportNamedDeclaration") && Array.isArray(statement.specifiers)) {
      for (const specifier of statement.specifiers) {
        if (isNode(specifier) && (isIdentifier(specifier.exported, "default") || stringValue(specifier.exported) === "default")) {
          return { node: statement, value: undefined }
        }
      }
    }
  }
}

const handlerFactories = new Set(["defineEventHandler", "eventHandler", "defineHandler", "defineCachedEventHandler", "defineLazyEventHandler"])
const routeDirs = ["api", "routes", "middleware"]

/**
 * True when Nitro serves the file's default export: the file is under `api/`, `routes/`, or `middleware/` of a server
 * directory. The ViteHub Project Inventory lists the server directories, including a custom Nuxt `serverDir`.
 */
function isRouteFile(ctx: RuleContext): boolean {
  const path = ctx.file.relativePath
  // Without an inventory, the server directory is the default `server/` at the project root.
  const serverDirs = viteHubInventory(ctx).serverDirs ?? ["server"]
  return serverDirs.some(dir => routeDirs.some(route => path.startsWith(dir ? `${dir}/${route}/` : `${route}/`)))
}

/** True when `fn` handles a request: it is passed to `defineEventHandler()`, or it is the default export of a route file. */
export function isRouteHandler(ctx: RuleContext, fn: AstNode): boolean {
  const { parent } = semanticParent(fn)
  if (parent?.type === "ExportDefaultDeclaration") return isRouteFile(ctx)
  const callee = parent?.type === "CallExpression" ? unwrap(parent.callee) : undefined
  return isIdentifier(callee) && handlerFactories.has(callee.name)
}
