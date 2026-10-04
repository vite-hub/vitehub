import { createError, defineEventHandler, getQuery } from "h3"

import { CollectionCursorError } from "./core/collection.ts"

import type { H3Event } from "h3"
import type { AccessAuthorizeOption } from "@vite-hub/runtime"
import type { Collection, CollectionRequestQuery } from "./core/collection.ts"
import { sourceErrorDiagnostics } from "./error-diagnostics.ts"

export interface CollectionHandler {
  (event: unknown): Promise<unknown>
  fetch(input: Request | URL | string): Promise<Response>
}

export interface CollectionHandlerEvent {
  req: { signal: AbortSignal }
}

/** Authorizes one Collection request. Return a `Response` to reject it. */
export type CollectionRequestAuthorizer = (
  event: { req: Request },
  authorize: AccessAuthorizeOption,
) => Promise<Response | undefined>

export interface CollectionHandlerOptions {
  /** Required when the Collection declares `authorize`. Generated routes pass Auth's `authorizeRequest`. */
  authorizeRequest?: CollectionRequestAuthorizer
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

function invalidRequest(cause: unknown): never {
  throw createError({
    cause,
    statusCode: 400,
    statusMessage: cause instanceof Error ? cause.message : "Invalid collection request.",
  })
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

function hasDeclaredMethod(value: object, key: PropertyKey): boolean {
  if (Object.hasOwn(value, key)) return typeof Reflect.get(value, key) === "function"
  let prototype = Object.getPrototypeOf(value)
  while (prototype && prototype !== Object.prototype) {
    if (Object.hasOwn(prototype, key)) {
      return Object.hasOwn(prototype, "constructor") && prototype.constructor !== Object
        && typeof Reflect.get(value, key) === "function"
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
  const { authorize } = collection
  const { authorizeRequest } = options
  if (authorize && !authorizeRequest) {
    // Fail closed: without Auth, the route cannot read a session.
    throw sourceErrorDiagnostics.SOURCE_R0025({ message: "[vitehub] Collection authorize requires Auth. Enable Auth and add `server/auth.ts`." })
  }
  // SAFETY: CollectionHandler preserves the callable and fetch contracts exposed by H3's handler.
  return defineEventHandler(async (event: H3Event) => {
    if (authorize && authorizeRequest) {
      const rejection = await authorizeRequest(event, authorize)
      if (rejection) return rejection
    }
    const requestQuery = getQuery(event)
    let cursor: string | undefined
    let limit: number | undefined
    let query: TQuery
    try {
      cursor = queryValue(requestQuery, "cursor")
      limit = queryLimit(requestQuery)
      query = await collection.parseQuery(collectionQuery(requestQuery))
    } catch (cause) {
      invalidRequest(cause)
    }

    try {
      return serializeCollectionPage(await collection.page({ cursor, limit, query, signal: event.req.signal }))
    } catch (cause) {
      if (cause instanceof CollectionCursorError) invalidRequest(cause)
      throw cause
    }
  }) as CollectionHandler
}
