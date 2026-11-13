import { CollectionCursorError } from "./core/collection.ts"

import type { AccessAuthorizeOption } from "@vite-hub/runtime"
import type { Collection, CollectionRequestQuery } from "./core/collection.ts"
import { sourceErrorDiagnostics } from "./error-diagnostics.ts"

export { cachedSource } from "./cached-source.ts"
export type { SourceReaderCacheOptions } from "./cached-source.ts"

/** A Collection route as a Fetchable. Mount it as a Nitro route, or call `fetch()` with a Web Request. */
export interface CollectionHandler {
  fetch(request: Request): Promise<Response>
}

/** Wraps a Collection handler so it runs only after the request is authorized. Return a `Response` to reject the request. */
export type CollectionAuthorizationGuard = <TResult>(
  authorize: AccessAuthorizeOption,
  handler: (request: Request) => Promise<TResult>,
) => (request: Request) => Promise<TResult | Response>

export interface CollectionHandlerOptions {
  /** Required unless the Collection sets `authorize: false`. Generated routes pass Auth's `withAuthorization`. */
  withAuthorization?: CollectionAuthorizationGuard
}

/** The query of a request URL. A parameter that the URL repeats becomes an array, as in H3's `getQuery()`. */
function requestQuery(request: Request): Record<string, string | string[]> {
  const query = new Map<string, string | string[]>()
  for (const [key, value] of new URL(request.url).searchParams) {
    const current = query.get(key)
    query.set(key, current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value])
  }
  return Object.fromEntries(query)
}

function queryValue(query: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = query[key]
  if (Array.isArray(value)) {
    throw sourceErrorDiagnostics.SOURCE_R0011({ message: `[vitehub] Collection query parameter ${JSON.stringify(key)} must have one value.` })
  }
  return value
}

function queryLimit(query: Record<string, string | string[] | undefined>): number | undefined {
  const value = queryValue(query, "limit")
  if (value === undefined) return
  if (!/^\d+$/.test(value)) throw sourceErrorDiagnostics.SOURCE_R0012({ message: "[vitehub] Collection limit must be a positive integer." })
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw sourceErrorDiagnostics.SOURCE_R0013({ message: "[vitehub] Collection limit must be a positive integer." })
  }
  return limit
}

function collectionQuery(query: Record<string, string | string[] | undefined>): CollectionRequestQuery {
  return Object.fromEntries(Object.entries(query).filter(([key]) => key !== "cursor" && key !== "limit"))
}

/** An error Response with the `status` and `message` fields of an H3 error body. */
function errorResponse(status: number, message: string): Response {
  return Response.json({ status, message }, { status })
}

function invalidRequest(cause: unknown): Response {
  return errorResponse(400, cause instanceof Error ? cause.message : "Invalid collection request.")
}

function isJSONContainer(value: unknown): value is object {
  return Object(value) === value && !(value instanceof Function)
}

function serializeCollectionPage(value: unknown): unknown {
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (!isJSONContainer(entry) || Array.isArray(entry)) return entry
    const prototype = Object.getPrototypeOf(entry)
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      throw sourceErrorDiagnostics.SOURCE_R0014({ message: "[vitehub] Collection pages may only contain plain objects, arrays, and toJSON() values. Use transform() for class instances and other object types." })
    }
    return entry
  })
  if (serialized === undefined) {
    throw sourceErrorDiagnostics.SOURCE_R0015({ message: "[vitehub] Collection page is not JSON-serializable." })
  }
  return JSON.parse(serialized)
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  // Callable HTMLDDA browser values report undefined without being undefined.
  return typeof value === "function" || (typeof value === "undefined" && value !== undefined)
}

function hasDeclaredMethod(value: unknown, key: PropertyKey): boolean {
  const object = Object(value)
  if (Object.hasOwn(object, key)) return isCallable(Reflect.get(object, key))
  let prototype = Object.getPrototypeOf(object)
  while (prototype && prototype !== Object.prototype) {
    if (Object.hasOwn(prototype, key)) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
      return isCallable(constructor) && constructor !== Object && constructor.prototype === prototype
        && isCallable(Reflect.get(object, key))
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return false
}

function assertCollection(value: unknown): asserts value is Collection<unknown, object, object> {
  if (
    Object(value) !== value ||
    !hasDeclaredMethod(Object(value), "page") ||
    !hasDeclaredMethod(Object(value), "parseQuery")
  ) {
    throw sourceErrorDiagnostics.SOURCE_R0016({ message: "[vitehub] defineCollectionHandler() requires a Collection." })
  }
}

export function defineCollectionHandler<TItem, TQuery extends object, TQueryInput extends object>(
  collection: Collection<TItem, TQuery, TQueryInput>,
  options: CollectionHandlerOptions = {},
): CollectionHandler {
  assertCollection(collection)
  // The build reads only a literal `route: false`. For any other form it writes the route, and the route answers 404.
  if (collection.route === false) return { fetch: async () => errorResponse(404, "Not Found") }
  const { authorize } = collection
  const { withAuthorization } = options
  // Fail closed: a Collection object that does not say who can read it gets no route.
  if (authorize === undefined) throw sourceErrorDiagnostics.SOURCE_R0035()
  if (authorize !== false && !withAuthorization) {
    // Fail closed: without Auth, the route cannot read a session.
    throw sourceErrorDiagnostics.SOURCE_R0025({ message: "[vitehub] Collection authorize requires Auth. Enable Auth and add `server/auth.ts`." })
  }
  const handlePage = async (request: Request): Promise<Response> => {
    const parameters = requestQuery(request)
    let cursor: string | undefined
    let limit: number | undefined
    let query: TQuery
    try {
      cursor = queryValue(parameters, "cursor")
      limit = queryLimit(parameters)
      query = await collection.parseQuery(collectionQuery(parameters))
    } catch (cause) {
      return invalidRequest(cause)
    }

    try {
      return Response.json(serializeCollectionPage(await collection.page({ cursor, limit, query, signal: request.signal })))
    } catch (cause) {
      if (cause instanceof CollectionCursorError) {
        return cause.reason === "stale" ? errorResponse(409, cause.message) : invalidRequest(cause)
      }
      throw cause
    }
  }
  return { fetch: authorize !== false && withAuthorization ? withAuthorization(authorize, handlePage) : handlePage }
}
