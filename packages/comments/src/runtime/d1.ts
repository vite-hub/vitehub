import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import { drizzle } from "drizzle-orm/sqlite-proxy"

import { commentsTables } from "../tables.ts"

import type { CommentsDatabase } from "../store.ts"

/** The parts of a Cloudflare D1 binding that Comments uses. */
interface D1Binding {
  prepare(query: string): D1Statement
  batch(statements: D1Statement[]): Promise<Array<{ results?: unknown[] }>>
}

interface D1Statement {
  bind(...values: unknown[]): D1Statement
  run(): Promise<unknown>
  raw(): Promise<unknown[][]>
}

function isD1Binding(value: unknown): value is D1Binding {
  return value !== null && typeof value === "object" && typeof Reflect.get(value, "prepare") === "function" && typeof Reflect.get(value, "batch") === "function"
}

/** Creates the tables once for each binding, and again on the next query if it failed. */
const ready = new WeakMap<D1Binding, Promise<unknown>>()

function createTables(d1: D1Binding): Promise<unknown> {
  let tables = ready.get(d1)
  if (!tables) {
    tables = d1.batch(commentsTables.map(statement => d1.prepare(statement)))
    tables.catch(() => ready.delete(d1))
    ready.set(d1, tables)
  }
  return tables
}

function openBinding(d1: D1Binding): CommentsDatabase {
  const database: CommentsDatabase = drizzle<Record<string, unknown>>(
    async (query, params, method) => {
      await createTables(d1)
      const statement = d1.prepare(query).bind(...params)
      if (method === "run") {
        await statement.run()
        return { rows: [] }
      }
      const rows = await statement.raw()
      return { rows: method === "get" ? rows[0] ?? [] : rows }
    },
    // A D1 batch is one transaction.
    async (queries) => {
      await createTables(d1)
      const results = await d1.batch(queries.map(({ sql, params }) => d1.prepare(sql).bind(...params)))
      // D1 returns batch rows as objects; Drizzle reads them as arrays of column values, as its D1 driver does.
      return results.map((result, index) => ({
        rows: queries[index]!.method === "run" ? [] : (result.results ?? []).map(row => row !== null && typeof row === "object" ? Object.values(row) : []),
      }))
    },
  )
  return database
}

/**
 * The Cloudflare D1 database of the binding `binding`. Comments creates its tables on the first query, so it needs no
 * migration. A Worker has its bindings only during a request, so each query reads the binding of the request.
 * `fallback` is the database to use when there is no binding, as on the development server.
 */
export function openCommentsD1(binding: string, options: { fallback?: () => CommentsDatabase } = {}): CommentsDatabase {
  const instances = new WeakMap<D1Binding, CommentsDatabase>()
  let fallback: CommentsDatabase | undefined

  function current(): CommentsDatabase {
    const d1: unknown = getActiveCloudflareBinding<unknown>(binding)
    if (isD1Binding(d1)) {
      let instance = instances.get(d1)
      if (!instance) {
        instance = openBinding(d1)
        instances.set(d1, instance)
      }
      return instance
    }
    if (options.fallback) return fallback ??= options.fallback()
    throw new Error(`[vitehub] Comments has no D1 binding "${binding}". Add it to wrangler.jsonc under "d1_databases", or run \`wrangler d1 create comments --binding ${binding} --update-config\`.`)
  }

  // SAFETY: every property read is forwarded to the Drizzle database of the request's binding.
  return new Proxy({} as CommentsDatabase, {
    get(_, property) {
      const database = current()
      const value: unknown = Reflect.get(database, property)
      return typeof value === "function" ? value.bind(database) : value
    },
  })
}
