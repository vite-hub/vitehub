import { createError, defineEventHandler, getQuery } from "h3"

import { CollectionCursorError } from "./core/collection.ts"

import type { H3Event } from "h3"
import type { Collection, CollectionRequestQuery } from "./core/collection.ts"

function queryValue(
  query: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = query[key]
  if (Array.isArray(value)) {
    throw new TypeError(
      `[vitehub] Collection query parameter ${JSON.stringify(key)} must have one value.`,
    )
  }
  return value
}

function queryLimit(query: Record<string, string | string[] | undefined>): number | undefined {
  const value = queryValue(query, "limit")
  if (value === undefined) return
  if (!/^\d+$/.test(value))
    throw new TypeError("[vitehub] Collection limit must be a positive integer.")
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("[vitehub] Collection limit must be a positive integer.")
  }
  return limit
}

function collectionQuery(
  query: Record<string, string | string[] | undefined>,
): CollectionRequestQuery {
  return Object.fromEntries(
    Object.entries(query).filter(([key]) => key !== "cursor" && key !== "limit"),
  )
}

function invalidRequest(cause: unknown): never {
  throw createError({
    cause,
    statusCode: 400,
    statusMessage: cause instanceof Error ? cause.message : "Invalid collection request.",
  })
}

function assertCollection(value: unknown): asserts value is Collection<unknown, object> {
  if (
    !value
    || typeof value !== "object"
    || typeof (value as Partial<Collection<unknown, object>>).page !== "function"
    || typeof (value as Partial<Collection<unknown, object>>).parseQuery !== "function"
  ) {
    throw new TypeError("[vitehub] defineCollectionHandler() requires a Collection.")
  }
}

export function defineCollectionHandler<TItem, TQuery extends object>(
  collection: Collection<TItem, TQuery>,
): ReturnType<typeof defineEventHandler> {
  assertCollection(collection)
  return defineEventHandler(async (event: H3Event) => {
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
      return await collection.page({ cursor, limit, query, signal: event.req.signal })
    } catch (cause) {
      if (cause instanceof CollectionCursorError) invalidRequest(cause)
      throw cause
    }
  })
}
