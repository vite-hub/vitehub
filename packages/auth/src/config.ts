import { readFileSync } from "node:fs"

import { defaultExportExpression, objectProperties, scanModule, staticString, staticValue, unwrapExpression, walk } from "@vite-hub/internal/build/scan-module"

import type { Expression, ObjectExpression } from "@vite-hub/internal/build/scan-module"

import { discoverAuthDefinition } from "./discovery.ts"
import { normalizeAuthBasePath } from "./shared.ts"

import type {
  AuthModuleOptions,
  ResolvedAuthAccessRoute,
  ResolvedAuthDatabaseConfiguration,
  ResolvedAuthSecondaryStorageConfiguration,
  ResolvedAuthViteConfig,
} from "./types.ts"
import { authErrorDiagnostics } from "./error-diagnostics.ts"

interface DefinitionObjectBody {
  body: ObjectExpression
  callback: boolean
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
  const call = defaultExportExpression(scanModule(readFileSync(file, "utf8"), file))
  if (call?.type !== "CallExpression" || call.callee.type !== "Identifier" || call.callee.name !== "defineAuth") return
  const argument = call.arguments[0]
  if (argument === undefined || argument.type === "SpreadElement") return
  const options = unwrapExpression(argument)
  if (options.type === "ObjectExpression") return { body: options, callback: false }
  const returned = readReturnedObject(options)
  return returned === undefined ? undefined : { body: returned, callback: true }
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
  return readObjectEntries(body).find(entry => entry.key === property)?.value
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

function readStaticBooleanProperty(body: ObjectExpression | undefined, property: string, label: string): boolean | undefined {
  if (!hasObjectProperty(body, property)) return
  const value = readStaticBooleanLiteral(readObjectPropertyValue(body, property))
  if (typeof value === "undefined") {
    throw authErrorDiagnostics.AUTH_C0004({ message: `\`defineAuth()\` ${label} must be an inline boolean literal.` })
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

function readAuthAccessRoute(entry: Expression | undefined, index: number): ResolvedAuthAccessRoute {
  const route = staticString(entry)
  if (typeof route !== "undefined") {
    if (!route.startsWith("/")) {
      throw authErrorDiagnostics.AUTH_C0009({ message: `\`defineAuth()\` access.routes[${index}] must start with \`/\`.` })
    }
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

function readAuthDatabaseConfig(body: ObjectExpression | undefined, allowRuntimeValue = false): ResolvedAuthDatabaseConfiguration {
  if (!hasObjectProperty(body, "database")) return { mode: "default" }

  const expression = readObjectPropertyValue(body, "database")
  const flag = readStaticBooleanLiteral(expression)
  if (flag === true) return { mode: "default" }
  if (flag === false) {
    throw authErrorDiagnostics.AUTH_C0013({ message: "`defineAuth()` database cannot be `false`." })
  }

  const database = objectLiteral(expression)
  if (typeof database === "undefined") {
    if (allowRuntimeValue) return { mode: "default" }
    throw authErrorDiagnostics.AUTH_C0014({ message: "`defineAuth()` database must be `true` or an inline object with `name`." })
  }

  assertOnlyObjectKeys(database, new Set(["dedicated", "name"]), "database")

  return {
    dedicated: readStaticBooleanProperty(database, "dedicated", "database.dedicated") ?? false,
    mode: "named",
    name: readStaticStringProperty(database, "name", "database.name") ?? (() => {
      throw authErrorDiagnostics.AUTH_C0015({ message: "`defineAuth()` database.name is required when database is an object." })
    })(),
  }
}

function readAuthSecondaryStorageConfig(body: ObjectExpression | undefined, allowRuntimeValue = false): false | ResolvedAuthSecondaryStorageConfiguration {
  if (!hasObjectProperty(body, "secondaryStorage")) return false

  const expression = readObjectPropertyValue(body, "secondaryStorage")
  const flag = readStaticBooleanLiteral(expression)
  if (flag === true) return { mode: "default" }
  if (flag === false) {
    throw authErrorDiagnostics.AUTH_C0016({ message: "`defineAuth()` secondaryStorage cannot be `false`." })
  }

  const secondaryStorage = objectLiteral(expression)
  if (typeof secondaryStorage === "undefined") {
    if (allowRuntimeValue) return false
    throw authErrorDiagnostics.AUTH_C0017({ message: "`defineAuth()` secondaryStorage must be `true` or an inline object with `store`." })
  }

  assertOnlyObjectKeys(secondaryStorage, new Set(["store"]), "secondaryStorage")

  return {
    mode: "named",
    store: readStaticStringProperty(secondaryStorage, "store", "secondaryStorage.store") ?? (() => {
      throw authErrorDiagnostics.AUTH_C0018({ message: "`defineAuth()` secondaryStorage.store is required when secondaryStorage is an object." })
    })(),
  }
}

export function resolveAuthViteConfig(
  options?: AuthModuleOptions,
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
  const basePath = normalizeAuthBasePath(readStaticStringProperty(body, "basePath", "basePath"))

  return {
    access: {
      routes: readAuthAccessRoutesConfig(body),
    },
    basePath,
    database: readAuthDatabaseConfig(body, definitionObject.callback),
    definition,
    rootDir,
    route: readAuthRouteConfig(body),
    secondaryStorage: readAuthSecondaryStorageConfig(body, definitionObject.callback),
  }
}
