import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { defaultExportExpression, objectProperties, scanModule, staticString, staticValue, unwrapExpression, walk } from "@vite-hub/internal/build/scan-module"

import type { CallExpression, Expression, Node, ObjectExpression, ScannedModule } from "@vite-hub/internal/build/scan-module"

import { accessRouteSyntaxError } from "./application-path.ts"
import { discoverAuthAbilities, discoverAuthDefinition } from "./discovery.ts"
import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthOptions,
  ResolvedAuthAccessRoute,
  ResolvedAuthViteConfig,
} from "./types.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { assertAuthDatabaseIdStrategy, authDatabaseAdditionalFieldsError, authDatabasePlacementError, authDatabaseSchemaError } from "./database-options.ts"
import { resolveAuthTableSpecs } from "./table-specs.ts"

import type { AuthCoreModel, AuthSchemaOptions, AuthSchemaPlugin, AuthTableField } from "./table-specs.ts"

interface DefinitionObjectBody {
  body: ObjectExpression
  callback: boolean
  /** Local names of `authDatabase` imported from the Auth database module. */
  authDatabase: ReadonlySet<string>
  /** The plugins of `AuthSchemaPlugin` that the Definition module and the local modules it imports call. */
  plugins: AuthSchemaPlugin[]
}

const authDatabaseModules: ReadonlySet<string> = new Set(["@vite-hub/auth/database", "vite-hub/auth/database"])

function readAuthDatabaseImports(module: ScannedModule): Set<string> {
  const names = new Set<string>()
  for (const statement of module.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || !authDatabaseModules.has(statement.source.value)) continue
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue
      const imported = specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
      if (imported === "authDatabase") names.add(specifier.local.name)
    }
  }
  return names
}

/** The plugin factories whose tables `authDatabase()` adds, by the module that exports them. */
const authSchemaPluginImports: Readonly<Record<string, Readonly<Record<string, AuthSchemaPlugin>>>> = {
  "better-auth/plugins": { anonymous: "anonymous", lastLoginMethod: "lastLoginMethod", phoneNumber: "phoneNumber", twoFactor: "twoFactor", username: "username" },
  "@better-auth/api-key": { apiKey: "apiKey" },
  "@better-auth/stripe": { stripe: "stripe" },
}

// Vite's default `resolve.extensions`, in its order.
const viteExtensions = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"]
const typeScriptSources: Readonly<Record<string, readonly string[]>> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] }

const isFile = (file: string): boolean => existsSync(file) && statSync(file).isFile()

/**
 * The file of a relative import, resolved in the order Vite uses: the file itself, the TypeScript source of a `.js`
 * path, the path with each extension, then the `index` file of the folder.
 */
function resolveLocalModule(importer: string, specifier: string): string | undefined {
  const path = resolve(dirname(importer), specifier)
  if (isFile(path)) return path
  const extension = Object.keys(typeScriptSources).find(item => path.endsWith(item))
  const candidates = [
    ...extension ? typeScriptSources[extension]!.map(item => path.slice(0, -extension.length) + item) : [],
    ...viteExtensions.map(item => path + item),
    ...viteExtensions.map(item => resolve(path, `index${item}`)),
  ]
  return candidates.find(isFile)
}

const nameOf = (node: { type: string, name?: string, value?: unknown }): string => node.type === "Identifier" ? node.name! : String(node.value)

/** What one module needs from another: some export names, or the whole module. */
type ModuleNeeds = "all" | Set<string>

interface ModuleBindings {
  /** Top-level declarations by local name. */
  declarations: Map<string, Node[]>
  /** Value imports from local modules, by local name. `*` is a namespace import. */
  imports: Map<string, { file: string, imported: string }>
  /** Local names and re-exports, by export name. */
  exports: Map<string, { local: string } | { file: string, imported: string }>
  /** The local modules of `export * from`. */
  exportAll: string[]
  /** The plugin factories that the module imports, by local name. */
  pluginFactories: Map<string, AuthSchemaPlugin>
}

function addBoundNames(pattern: Node, names: string[]): void {
  walk(pattern, (node) => {
    if (node.type === "Identifier") names.push(node.name)
    // A default value is an expression, not a bound name.
    if (node.type === "AssignmentPattern") {
      addBoundNames(node.left, names)
      return false
    }
  })
}

function readModuleBindings(module: ScannedModule): ModuleBindings {
  const bindings: ModuleBindings = { declarations: new Map(), imports: new Map(), exports: new Map(), exportAll: [], pluginFactories: new Map() }
  const localFile = (specifier: string) => specifier.startsWith("./") || specifier.startsWith("../") ? resolveLocalModule(module.file, specifier) : undefined
  const declare = (name: string, node: Node) => bindings.declarations.set(name, [...bindings.declarations.get(name) ?? [], node])
  const readDeclaration = (declaration: Node, exported: boolean) => {
    const names: string[] = []
    if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) names.push(declaration.id.name)
    if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        const bound: string[] = []
        addBoundNames(declarator.id, bound)
        for (const name of bound) declare(name, declarator)
        names.push(...bound)
      }
    }
    else for (const name of names) declare(name, declaration)
    if (exported) for (const name of names) bindings.exports.set(name, { local: name })
  }
  for (const statement of module.program.body) {
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue
      const source = statement.source.value
      const factories = authSchemaPluginImports[source.startsWith("better-auth/plugins/") ? "better-auth/plugins" : source]
      const file = localFile(source)
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue
        const imported = specifier.type === "ImportSpecifier" ? nameOf(specifier.imported) : specifier.type === "ImportDefaultSpecifier" ? "default" : "*"
        if (factories && Object.hasOwn(factories, imported)) bindings.pluginFactories.set(specifier.local.name, factories[imported]!)
        if (file) bindings.imports.set(specifier.local.name, { file, imported })
      }
    }
    else if (statement.type === "ExportNamedDeclaration") {
      if (statement.exportKind === "type") continue
      if (statement.declaration) readDeclaration(statement.declaration, true)
      const file = statement.source ? localFile(statement.source.value) : undefined
      for (const specifier of statement.specifiers) {
        if (specifier.exportKind === "type") continue
        const local = nameOf(specifier.local)
        if (statement.source) {
          if (file) bindings.exports.set(nameOf(specifier.exported), { file, imported: local })
        }
        else bindings.exports.set(nameOf(specifier.exported), { local })
      }
    }
    else if (statement.type === "ExportAllDeclaration") {
      const file = statement.exportKind === "type" ? undefined : localFile(statement.source.value)
      if (!file) continue
      if (statement.exported) bindings.exports.set(nameOf(statement.exported), { file, imported: "*" })
      else bindings.exportAll.push(file)
    }
    else if (statement.type === "ExportDefaultDeclaration") {
      declare("default", statement.declaration as Node)
      bindings.exports.set("default", { local: "default" })
      const declaration = statement.declaration as Node
      if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) declare(declaration.id.name, declaration)
    }
    else readDeclaration(statement as Node, false)
  }
  return bindings
}

/**
 * Reads what `needs` reaches in `module`: the plugin factories that its reached code calls, and what it needs from the
 * local modules it imports. The whole module counts for the Definition. In an imported module, only the exports that
 * the importer uses count, with the declarations and imports that they use.
 */
function readModuleNeeds(module: ScannedModule, needs: ModuleNeeds): { plugins: AuthSchemaPlugin[], imports: Array<[string, ModuleNeeds]> } {
  const bindings = readModuleBindings(module)
  const plugins = new Set<AuthSchemaPlugin>()
  const imports: Array<[string, ModuleNeeds]> = []
  const need = (file: string, imported: string) => imports.push([file, imported === "*" ? "all" : new Set([imported])])
  const collectCalls = (node: Node, references?: Set<string>) => walk(node, (child) => {
    if (child.type === "ImportDeclaration") return false
    if (child.type === "CallExpression" && child.callee.type === "Identifier" && bindings.pluginFactories.has(child.callee.name)) plugins.add(bindings.pluginFactories.get(child.callee.name)!)
    if (child.type === "Identifier") references?.add(child.name)
  })
  if (needs === "all") {
    const references = new Set<string>()
    collectCalls(module.program, references)
    for (const [name, { file, imported }] of bindings.imports) if (references.has(name)) need(file, imported)
    for (const [, target] of bindings.exports) if ("file" in target) need(target.file, target.imported)
    return { plugins: [...plugins], imports }
  }
  const locals: string[] = []
  for (const name of needs) {
    const target = bindings.exports.get(name)
    if (!target) for (const file of bindings.exportAll) need(file, name)
    else if ("file" in target) need(target.file, target.imported)
    else locals.push(target.local)
  }
  const reached = new Set<string>()
  for (let local = locals.pop(); local !== undefined; local = locals.pop()) {
    if (reached.has(local)) continue
    reached.add(local)
    const imported = bindings.imports.get(local)
    if (imported) need(imported.file, imported.imported)
    const references = new Set<string>()
    for (const declaration of bindings.declarations.get(local) ?? []) collectCalls(declaration, references)
    for (const reference of references) if (bindings.declarations.has(reference) || bindings.imports.has(reference)) locals.push(reference)
  }
  return { plugins: [...plugins], imports }
}

/**
 * The plugins of `AuthSchemaPlugin` that the Definition module calls, and that the local modules it imports call in
 * the exports it uses, such as `stripe()` in `src/server/auth-plugins.ts` that returns the plugins of `server/auth.ts`.
 */
function readDefinitionSchemaPlugins(definition: ScannedModule): AuthSchemaPlugin[] {
  const plugins = new Set<AuthSchemaPlugin>()
  const modules = new Map<string, ScannedModule>([[definition.file, definition]])
  const done = new Map<string, ModuleNeeds>()
  const queue: Array<[string, ModuleNeeds]> = [[definition.file, "all"]]
  for (let item = queue.shift(); item; item = queue.shift()) {
    const [file, needs] = item
    const previous = done.get(file)
    if (previous === "all") continue
    const fresh: ModuleNeeds = needs === "all" ? "all" : new Set([...needs].filter(name => !previous?.has(name)))
    if (fresh !== "all" && !fresh.size) continue
    done.set(file, fresh === "all" ? "all" : new Set([...previous ?? [], ...fresh]))
    let module = modules.get(file)
    if (!module) modules.set(file, module = scanModule(readFileSync(file, "utf8"), file))
    const result = readModuleNeeds(module, fresh)
    for (const plugin of result.plugins) plugins.add(plugin)
    queue.push(...result.imports)
  }
  return [...plugins].sort()
}

const authFieldTypes: ReadonlySet<string> = new Set(["boolean", "date", "json", "number", "number[]", "string", "string[]"])

function readStaticBooleanOption(field: ObjectExpression, key: string, label: string): boolean | undefined {
  if (!hasObjectProperty(field, key)) return
  const value = readStaticBooleanLiteral(readObjectPropertyValue(field, key))
  if (value === undefined) throw authDatabaseAdditionalFieldsError(`${label}.${key} must be \`true\` or \`false\``)
  return value
}

/** One additional field, read from its object literal: the parts that shape the column. */
function readAdditionalField(value: Expression | undefined, key: string, label: string): AuthTableField {
  const field = objectLiteral(value && unwrapExpression(value))
  if (!field) throw authDatabaseAdditionalFieldsError(`${label} must be an inline object, such as \`{ type: "string", required: false }\``)
  const typeValue = readObjectPropertyValue(field, "type")
  const unwrappedType = typeValue && unwrapExpression(typeValue)
  // A list of values, such as `["en", "es"]`, is a string column. Better Auth checks the value.
  const type = unwrappedType?.type === "ArrayExpression" ? "string" : staticString(unwrappedType)
  if (!type || !authFieldTypes.has(type)) throw authDatabaseAdditionalFieldsError(`${label}.type must be one of ${[...authFieldTypes].map(name => `"${name}"`).join(", ")}, or a list of strings`)
  const fieldName = readObjectPropertyValue(field, "fieldName")
  if (fieldName && staticString(fieldName) !== key) throw authDatabaseSchemaError(`${label}.fieldName cannot rename the column`)
  const spec: AuthTableField = { type: type as AuthTableField["type"] }
  if (readStaticBooleanOption(field, "required", label)) spec.required = true
  if (readStaticBooleanOption(field, "unique", label)) spec.unique = true
  if (readStaticBooleanOption(field, "index", label)) spec.index = true
  if (readStaticBooleanOption(field, "bigint", label)) spec.bigint = true
  // A function or a computed default stays in Better Auth, which sets the value when it writes the row.
  const defaultValue = readObjectPropertyValue(field, "defaultValue")
  const staticDefault = defaultValue && staticValue(defaultValue)
  if (typeof staticDefault === "string" || typeof staticDefault === "number" || typeof staticDefault === "boolean") spec.defaultValue = staticDefault
  const references = readObjectPropertyValue(field, "references")
  if (references) {
    const reference = staticValue(references)
    const model = typeof reference === "object" && reference !== null && !Array.isArray(reference) ? reference.model : undefined
    const target = typeof reference === "object" && reference !== null && !Array.isArray(reference) ? reference.field : undefined
    const onDelete = typeof reference === "object" && reference !== null && !Array.isArray(reference) ? reference.onDelete ?? "cascade" : undefined
    if (typeof model !== "string" || typeof target !== "string" || (onDelete !== "cascade" && onDelete !== "set null")) {
      throw authDatabaseAdditionalFieldsError(`${label}.references must be an inline object, such as \`{ model: "user", field: "id", onDelete: "cascade" }\``)
    }
    spec.references = { model, field: target, onDelete }
  }
  return spec
}

/** The `additionalFields` of each core model, which `authDatabase()` adds as columns. */
function readAuthAdditionalFields(body: ObjectExpression | undefined): AuthSchemaOptions["additionalFields"] {
  const result: NonNullable<AuthSchemaOptions["additionalFields"]> = {}
  for (const model of ["user", "session", "account", "verification"] as const satisfies readonly AuthCoreModel[]) {
    const config = objectLiteral(readObjectPropertyValue(body, model))
    const value = readObjectPropertyValue(config, "additionalFields")
    if (!value) continue
    const fields = objectLiteral(unwrapExpression(value))
    if (!fields) throw authDatabaseAdditionalFieldsError(`${model}.additionalFields must be an inline object literal, so the Auth Vite plugin can add its columns`)
    const entries = readObjectEntries(fields)
    if (entries.some(entry => !entry.key)) throw authDatabaseAdditionalFieldsError(`${model}.additionalFields must use static keys`)
    if (entries.length) result[model] = Object.fromEntries(entries.map(entry => [entry.key, readAdditionalField(entry.value, entry.key, `${model}.additionalFields.${entry.key}`)]))
  }
  return Object.keys(result).length ? result : undefined
}

/** The object that a callback returns, from `() => ({ ... })` or the first `return { ... }` in its body. */
function readReturnedObject(callback: Expression): ObjectExpression | undefined {
  if (callback.type !== "ArrowFunctionExpression") return
  if (callback.body.type !== "BlockStatement") {
    const body = unwrapExpression(callback.body)
    return body.type === "ObjectExpression" ? body : undefined
  }
  let returned: Expression | null | undefined
  walk(callback.body, (node) => {
    if (returned !== undefined) return false
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return false
    if (node.type === "ReturnStatement") {
      returned = node.argument
      return false
    }
  })
  const value = returned ? unwrapExpression(returned) : undefined
  return value?.type === "ObjectExpression" ? value : undefined
}

function readDefinitionObjectBody(file: string): DefinitionObjectBody | undefined {
  const module = scanModule(readFileSync(file, "utf8"), file)
  const authDatabase = readAuthDatabaseImports(module)
  const call = defaultExportExpression(module)
  if (call?.type !== "CallExpression" || call.callee.type !== "Identifier" || call.callee.name !== "defineAuth") return
  const argument = call.arguments[0]
  if (argument === undefined || argument.type === "SpreadElement") return
  const options = unwrapExpression(argument)
  const plugins = readDefinitionSchemaPlugins(module)
  if (hasObjectProperty(objectLiteral(options) ?? readReturnedObject(options), "runtime")) {
    throw authErrorDiagnostics.AUTH_C0039({ message: "`defineAuth()` no longer takes `runtime`. Pass one callback that returns all options, so no option replaces another." })
  }
  if (options.type === "ObjectExpression") {
    assertAuthDatabasePlacement(options, options, authDatabase)
    return { authDatabase, body: options, callback: false, plugins }
  }
  const returned = readReturnedObject(options)
  assertAuthDatabasePlacement(options, returned, authDatabase)
  return returned === undefined ? undefined : { authDatabase, body: returned, callback: true, plugins }
}

/** Owned tables must have the same target in every request and in the build-time contribution. */
function assertAuthDatabasePlacement(options: Expression, body: ObjectExpression | undefined, names: ReadonlySet<string>): void {
  const calls: CallExpression[] = []
  walk(options, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && names.has(node.callee.name)) calls.push(node)
  })
  if (!calls.length) return
  if (calls.length !== 1 || calls[0] !== readAuthDatabaseCall(body, names)) throw authDatabasePlacementError()
  if (options.type === "ArrowFunctionExpression" && options.body.type === "BlockStatement") {
    let returns = 0
    walk(options.body, (node) => {
      if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") return false
      if (node.type === "ReturnStatement") returns++
    })
    const unconditional = options.body.body.some(statement => statement.type === "ReturnStatement" && statement.argument && unwrapExpression(statement.argument) === body)
    if (returns !== 1 || !unconditional) throw authDatabasePlacementError()
  }
  const advanced = objectLiteral(readObjectPropertyValue(body, "advanced"))
  const database = objectLiteral(readObjectPropertyValue(advanced, "database"))
  const generateId = readObjectPropertyValue(database, "generateId")
  if (generateId) assertAuthDatabaseIdStrategy(staticValue(generateId))
}

/** Object entries. `key` is empty for spread and computed keys. `value` is undefined for methods and accessors. */
function readObjectEntries(body: ObjectExpression | undefined): Array<{ key: string; value: Expression | undefined }> {
  if (!body) return []
  return objectProperties(body).map(property => ({
    key: property.computed ? "" : property.key ?? "",
    value: property.node.type === "Property" && property.node.kind === "init" && !property.node.method ? property.value : undefined,
  }))
}

function readObjectPropertyValue(body: ObjectExpression | undefined, property: string): Expression | undefined {
  return readObjectEntries(body).findLast(entry => entry.key === property)?.value
}

function hasObjectProperty(body: ObjectExpression | undefined, property: string): boolean {
  return readObjectEntries(body).some(entry => entry.key === property)
}

function objectLiteral(value: Expression | undefined): ObjectExpression | undefined {
  return value?.type === "ObjectExpression" ? value : undefined
}

function readStaticBooleanLiteral(expression: Expression | undefined): boolean | undefined {
  const value = expression && staticValue(expression)
  return typeof value === "boolean" ? value : undefined
}

function readStaticStringProperty(body: ObjectExpression | undefined, property: string, label: string): string | undefined {
  if (!hasObjectProperty(body, property)) return
  const value = staticString(readObjectPropertyValue(body, property))
  if (typeof value === "undefined") {
    throw authErrorDiagnostics.AUTH_C0001({ message: `\`defineAuth()\` ${label} must be an inline string literal.` })
  }
  if (value.trim().length === 0 || value !== value.trim()) {
    throw authErrorDiagnostics.AUTH_C0002({ message: `\`defineAuth()\` ${label} must be a non-empty trimmed string.` })
  }
  return value
}

function readStaticRouteProperty(body: ObjectExpression | undefined, property: string, label: string): string | undefined {
  const value = readStaticStringProperty(body, property, label)
  if (typeof value !== "undefined" && !value.startsWith("/")) {
    throw authErrorDiagnostics.AUTH_C0003({ message: `\`defineAuth()\` ${label} must start with \`/\`.` })
  }
  return value
}

function assertOnlyObjectKeys(body: ObjectExpression | undefined, allowed: Set<string>, label: string): void {
  const unknownEntry = readObjectEntries(body).find(entry => !entry.key || !allowed.has(entry.key))
  if (!unknownEntry) return
  if (!unknownEntry.key) {
    throw authErrorDiagnostics.AUTH_C0005({ message: `\`defineAuth()\` ${label} must use static object keys.` })
  }
  throw authErrorDiagnostics.AUTH_C0006({ message: `\`defineAuth()\` ${label} does not support the "${unknownEntry.key}" option.` })
}

function assertStaticObjectKeys(body: ObjectExpression | undefined, label: string): void {
  if (readObjectEntries(body).some(entry => !entry.key)) {
    throw authErrorDiagnostics.AUTH_C0007({ message: `\`defineAuth()\` ${label} must use static object keys.` })
  }
}

function readAuthRouteConfig(body: ObjectExpression | undefined): false | string {
  const basePath = normalizeAuthBasePath(readStaticStringProperty(body, "basePath", "basePath"))
  if (!hasObjectProperty(body, "route")) return basePath

  const route = readStaticBooleanLiteral(readObjectPropertyValue(body, "route"))
  if (route === false) return false
  throw authErrorDiagnostics.AUTH_C0008({ message: "`defineAuth()` route can only be `false` when provided." })
}

function assertLiteralAccessRoute(route: string, label: string): void {
  const message = accessRouteSyntaxError(route, label)
  if (message) throw authErrorDiagnostics.AUTH_C0068({ message })
}

function readAuthAccessRoute(entry: Expression | undefined, index: number): ResolvedAuthAccessRoute {
  const route = staticString(entry)
  if (typeof route !== "undefined") {
    if (!route.startsWith("/")) {
      throw authErrorDiagnostics.AUTH_C0009({ message: `\`defineAuth()\` access.routes[${index}] must start with \`/\`.` })
    }
    assertLiteralAccessRoute(route, `access.routes[${index}]`)
    return { route }
  }

  const routeObject = objectLiteral(entry && unwrapExpression(entry))
  if (typeof routeObject === "undefined") {
    throw authErrorDiagnostics.AUTH_C0010({ message: `\`defineAuth()\` access.routes[${index}] must be an inline route string or route object.` })
  }

  assertOnlyObjectKeys(routeObject, new Set(["authorize", "method", "route"]), `access.routes[${index}]`)

  const resolvedRoute = readStaticRouteProperty(routeObject, "route", `access.routes[${index}].route`)
  if (!resolvedRoute) {
    throw authErrorDiagnostics.AUTH_C0011({ message: `\`defineAuth()\` access.routes[${index}].route is required.` })
  }
  assertLiteralAccessRoute(resolvedRoute, `access.routes[${index}].route`)

  const method = readStaticStringProperty(routeObject, "method", `access.routes[${index}].method`)
  const authorize = readObjectEntries(routeObject).find(entry => entry.key === "authorize")
  const resolved: ResolvedAuthAccessRoute = {
    route: resolvedRoute,
  }
  if (authorize) resolved.authorize = true
  if (method) resolved.method = method
  return resolved
}

function readAuthAccessRoutesConfig(body: ObjectExpression | undefined): ResolvedAuthAccessRoute[] {
  const access = objectLiteral(readObjectPropertyValue(body, "access"))
  if (!access || !hasObjectProperty(access, "routes")) return []

  const routes = readObjectPropertyValue(access, "routes")
  if (routes?.type !== "ArrayExpression") {
    throw authErrorDiagnostics.AUTH_C0012({ message: "`defineAuth()` access.routes must be an inline array." })
  }

  return routes.elements.map((entry, index) => readAuthAccessRoute(entry === null || entry.type === "SpreadElement" ? undefined : entry, index))
}

function readAuthAccessPublicConfig(body: ObjectExpression | undefined): string[] {
  const access = objectLiteral(readObjectPropertyValue(body, "access"))
  if (!access || !hasObjectProperty(access, "public")) return []

  const routes = readObjectPropertyValue(access, "public")
  if (routes?.type !== "ArrayExpression") {
    throw authErrorDiagnostics.AUTH_C0064({ message: "`defineAuth()` access.public must be an inline array." })
  }

  return routes.elements.map((entry, index) => {
    const route = entry === null || entry.type === "SpreadElement" ? undefined : staticString(entry)
    if (typeof route === "undefined" || !route.startsWith("/")) {
      throw authErrorDiagnostics.AUTH_C0064({ message: `\`defineAuth()\` access.public[${index}] must be an inline route string that starts with \`/\`.` })
    }
    return route
  })
}

/** `access.signIn` and `access.afterSignIn`, which the Nuxt page guard reads at build time, like `basePath`. */
function readAuthAccessSignInConfig(body: ObjectExpression | undefined): Pick<ResolvedAuthViteConfig["access"], "afterSignIn" | "signIn"> {
  const access = objectLiteral(readObjectPropertyValue(body, "access"))
  if (!access) return {}
  const resolved: Pick<ResolvedAuthViteConfig["access"], "afterSignIn" | "signIn"> = {}
  if (hasObjectProperty(access, "signIn")) {
    const value = readObjectPropertyValue(access, "signIn")
    const page = staticString(value)
    const provider = objectLiteral(value)
    if (provider && hasObjectProperty(provider, "callbackURL")) throw authErrorDiagnostics.AUTH_SIGN_IN_CALLBACK_URL_MOVED()
    if (provider) resolved.signIn = { provider: true }
    else if (page?.startsWith("/") && !/^\/[/\\]/.test(page)) resolved.signIn = { page }
    else throw authErrorDiagnostics.AUTH_C0028({ message: "`defineAuth()` access.signIn must be an inline path that starts with one `/`, such as `'/login'`, or an inline object, such as `{ provider: 'github' }`." })
  }
  if (hasObjectProperty(access, "afterSignIn")) {
    const afterSignIn = staticString(readObjectPropertyValue(access, "afterSignIn"))
    if (!afterSignIn?.startsWith("/") || /^\/[/\\]/.test(afterSignIn)) throw authErrorDiagnostics.AUTH_AFTER_SIGN_IN_INVALID()
    resolved.afterSignIn = afterSignIn
  }
  return resolved
}

/** The `authDatabase()` call of the `database` option, or undefined for any other value. */
function readAuthDatabaseCall(body: ObjectExpression | undefined, authDatabase: ReadonlySet<string>): CallExpression | undefined {
  const value = readObjectPropertyValue(body, "database")
  const expression = value && unwrapExpression(value)
  return expression?.type === "CallExpression" && expression.callee.type === "Identifier" && authDatabase.has(expression.callee.name) ? expression : undefined
}

/**
 * The Database that gets the Better Auth tables (the name that `authDatabase()` receives, `"default"` without one), and
 * the plugins and additional fields that add tables and columns.
 */
function readAuthTablesConfig(definition: DefinitionObjectBody): ResolvedAuthViteConfig["tables"] {
  const { authDatabase, body, plugins } = definition
  const call = readAuthDatabaseCall(body, authDatabase)
  if (!call) return false
  const [argument, ...rest] = call.arguments
  const name = argument === undefined ? "default" : argument.type === "SpreadElement" || rest.length ? undefined : staticString(argument)
  if (name === undefined || !name || name !== name.trim()) {
    throw authErrorDiagnostics.AUTH_C0052({ message: "`authDatabase()` takes the Database name as one inline string literal, such as `authDatabase(\"content\")`, or no argument for the `default` Database." })
  }
  const additionalFields = readAuthAdditionalFields(body)
  const schema: AuthSchemaOptions = { ...(plugins.length ? { plugins } : {}), ...(additionalFields ? { additionalFields } : {}) }
  if (!plugins.length && !additionalFields) return { database: name }
  // Report a field that a plugin or a core table already has with another type now, not when the schema loads.
  resolveAuthTableSpecs(schema)
  return { database: name, schema }
}

/** Reports `true`, `false`, or an object literal with only `keys`: the removed placement forms, which create no storage. */
function isPlacementLiteral(expression: Expression | undefined, keys: ReadonlySet<string>): boolean {
  if (readStaticBooleanLiteral(expression) !== undefined) return true
  const object = objectLiteral(expression)
  return object !== undefined && readObjectEntries(object).every(entry => keys.has(entry.key))
}

/**
 * `database` and `secondaryStorage` take Better Auth adapters only. A static Definition can hold only `authDatabase()` or
 * `"memory"`.
 */
function assertAuthStorageConfig(body: ObjectExpression | undefined, callback: boolean, authDatabase: ReadonlySet<string>): void {
  const database = readObjectPropertyValue(body, "database")
  if (hasObjectProperty(body, "database") && !readAuthDatabaseCall(body, authDatabase) && staticString(database) !== "memory") {
    if (!callback || isPlacementLiteral(database, new Set(["dedicated", "name"]))) {
      throw authErrorDiagnostics.AUTH_C0014({ message: "`defineAuth()` database must be `authDatabase()` from `vite-hub/auth/database` or `\"memory\"`. `true` and `{ name }` do not create storage. Return another Better Auth adapter from the Definition callback." })
    }
  }
  if (hasObjectProperty(body, "secondaryStorage")) {
    const secondaryStorage = readObjectPropertyValue(body, "secondaryStorage")
    if (!callback || isPlacementLiteral(secondaryStorage, new Set(["store"]))) {
      throw authErrorDiagnostics.AUTH_C0017({ message: "`defineAuth()` secondaryStorage takes only a Better Auth adapter, from the Definition callback. `true` and `{ store }` do not create storage." })
    }
  }
}

export function resolveAuthViteConfig(
  options?: AuthOptions,
  rootDir: string = process.cwd(),
  discovery: { serverDirs?: string[] } = {},
): ResolvedAuthViteConfig | undefined {
  if (options === false) return

  const definition = discoverAuthDefinition(rootDir, discovery)
  if (!definition) return

  const definitionObject = readDefinitionObjectBody(definition.handler)
  if (typeof definitionObject === "undefined") {
    throw authErrorDiagnostics.AUTH_C0019({ message: "`defineAuth()` options must be an inline object literal." })
  }
  const body = definitionObject.body
  assertStaticObjectKeys(body, "options")
  assertAuthStorageConfig(body, definitionObject.callback, definitionObject.authDatabase)
  const basePath = normalizeAuthBasePath(readStaticStringProperty(body, "basePath", "basePath"))

  const abilities = discoverAuthAbilities(rootDir, discovery)
  const publicRoutes = readAuthAccessPublicConfig(body)
  return {
    ...(abilities ? { abilities } : {}),
    access: {
      routes: readAuthAccessRoutesConfig(body),
      ...(publicRoutes.length ? { public: publicRoutes } : {}),
      ...readAuthAccessSignInConfig(body),
    },
    basePath,
    definition,
    rootDir,
    route: readAuthRouteConfig(body),
    tables: readAuthTablesConfig(definitionObject),
    ...(!definitionObject.callback && !["database", "preset"].some(key => hasObjectProperty(body, key)) ? { implicitMemory: true as const } : {}),
  }
}
