import { readFileSync } from "node:fs"

import { defaultExportExpression, objectProperties, scanModule, staticString, staticValue, unwrapExpression, walk } from "@vite-hub/internal/build/scan-module"

import type { CallExpression, Expression, ObjectExpression, ScannedModule } from "@vite-hub/internal/build/scan-module"

import { accessRouteSyntaxError } from "./application-path.ts"
import { discoverAuthAbilities, discoverAuthDefinition } from "./discovery.ts"
import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthOptions,
  ResolvedAuthAccessRoute,
  ResolvedAuthViteConfig,
} from "./types.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"
import { assertAuthDatabaseIdStrategy, authDatabaseAdditionalFieldsError, authDatabasePlacementError } from "./database-options.ts"

interface DefinitionObjectBody {
  body: ObjectExpression
  callback: boolean
  /** Local names of `authDatabase` imported from the Auth database module. */
  authDatabase: ReadonlySet<string>
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
  if (hasObjectProperty(objectLiteral(options) ?? readReturnedObject(options), "runtime")) {
    throw authErrorDiagnostics.AUTH_C0039({ message: "`defineAuth()` no longer takes `runtime`. Pass one callback that returns all options, so no option replaces another." })
  }
  if (options.type === "ObjectExpression") {
    assertAuthDatabasePlacement(options, options, authDatabase)
    return { authDatabase, body: options, callback: false }
  }
  const returned = readReturnedObject(options)
  assertAuthDatabasePlacement(options, returned, authDatabase)
  return returned === undefined ? undefined : { authDatabase, body: returned, callback: true }
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
  for (const model of ["user", "session", "account", "verification"]) {
    const config = objectLiteral(readObjectPropertyValue(body, model))
    const additionalFields = readObjectPropertyValue(config, "additionalFields")
    const fields = objectLiteral(additionalFields)
    if (additionalFields && (!fields || fields.properties.length)) throw authDatabaseAdditionalFieldsError(model)
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
  if (message) throw authErrorDiagnostics.AUTH_C0063({ message })
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

/** The `authDatabase()` call of the `database` option, or undefined for any other value. */
function readAuthDatabaseCall(body: ObjectExpression | undefined, authDatabase: ReadonlySet<string>): CallExpression | undefined {
  const value = readObjectPropertyValue(body, "database")
  const expression = value && unwrapExpression(value)
  return expression?.type === "CallExpression" && expression.callee.type === "Identifier" && authDatabase.has(expression.callee.name) ? expression : undefined
}

/** The Database that gets the Better Auth tables: the name that `authDatabase()` receives, `"default"` without one. */
function readAuthTablesConfig(body: ObjectExpression | undefined, authDatabase: ReadonlySet<string>): ResolvedAuthViteConfig["tables"] {
  const call = readAuthDatabaseCall(body, authDatabase)
  if (!call) return false
  const [argument, ...rest] = call.arguments
  if (argument === undefined) return { database: "default" }
  const name = argument.type === "SpreadElement" || rest.length ? undefined : staticString(argument)
  if (name === undefined || !name || name !== name.trim()) {
    throw authErrorDiagnostics.AUTH_C0052({ message: "`authDatabase()` takes the Database name as one inline string literal, such as `authDatabase(\"content\")`, or no argument for the `default` Database." })
  }
  return { database: name }
}

/** Reports `true`, `false`, or an object literal with only `keys`: the removed placement forms, which create no storage. */
function isPlacementLiteral(expression: Expression | undefined, keys: ReadonlySet<string>): boolean {
  if (readStaticBooleanLiteral(expression) !== undefined) return true
  const object = objectLiteral(expression)
  return object !== undefined && readObjectEntries(object).every(entry => keys.has(entry.key))
}

/** `database` and `secondaryStorage` take Better Auth adapters only. A static Definition can hold only `authDatabase()`. */
function assertAuthStorageConfig(body: ObjectExpression | undefined, callback: boolean, authDatabase: ReadonlySet<string>): void {
  if (hasObjectProperty(body, "database") && !readAuthDatabaseCall(body, authDatabase)) {
    const database = readObjectPropertyValue(body, "database")
    if (!callback || isPlacementLiteral(database, new Set(["dedicated", "name"]))) {
      throw authErrorDiagnostics.AUTH_C0014({ message: "`defineAuth()` database must be `authDatabase()` from `@vite-hub/auth/database`. `true` and `{ name }` do not create storage. Return another Better Auth adapter from the Definition callback." })
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
  return {
    ...(abilities ? { abilities } : {}),
    access: {
      routes: readAuthAccessRoutesConfig(body),
    },
    basePath,
    definition,
    rootDir,
    route: readAuthRouteConfig(body),
    tables: readAuthTablesConfig(body, definitionObject.authDatabase),
  }
}
