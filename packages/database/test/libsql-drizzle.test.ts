import { createClient } from "@libsql/client"
import { defineRelations, eq, sql, TransactionRollbackError } from "drizzle-orm"
import { Cache } from "drizzle-orm/cache/core"
import { drizzle } from "drizzle-orm/libsql"
import { integer, snakeCase, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createLibsqlDrizzle } from "../src/runtime/libsql-drizzle.ts"

import type { Client } from "@libsql/client"
import type { DrizzleConfig, Logger } from "drizzle-orm"
import type { LibSQLDatabase } from "drizzle-orm/libsql"
import type { MutationOption } from "drizzle-orm/cache/core"

const users = snakeCase.table("users", {
  fullName: text().notNull(),
  id: integer().primaryKey(),
})
const posts = snakeCase.table("posts", {
  id: integer().primaryKey(),
  title: text().notNull(),
  userId: integer().notNull(),
})
const relations = defineRelations({ posts, users }, r => ({
  posts: { author: r.one.users({ from: r.posts.userId, to: r.users.id }) },
  users: { posts: r.many.posts() },
}))

class RecordingCache extends Cache {
  readonly calls: unknown[] = []
  strategy() {
    return "all" as const
  }

  async get(key: string, tables: string[], isTag: boolean) {
    this.calls.push(["get", key, tables, isTag])
    return undefined
  }

  async put(key: string, response: unknown, tables: string[], isTag: boolean) {
    this.calls.push(["put", key, response, tables, isTag])
  }

  async onMutate(params: MutationOption) {
    this.calls.push(["onMutate", params])
  }
}

type Make = (client: Client, config: DrizzleConfig<typeof relations>) => LibSQLDatabase<typeof relations> & { $client: Client }

const makers: Record<"drizzle" | "createLibsqlDrizzle", Make> = {
  createLibsqlDrizzle: (client, config) => createLibsqlDrizzle(client, config),
  drizzle: (client, config) => drizzle({ client, ...config }),
}

async function exercise(make: Make) {
  const client = createClient({ url: ":memory:" })
  const queries: unknown[] = []
  const logger: Logger = { logQuery: (query, params) => queries.push([query, params]) }
  const cache = new RecordingCache()
  const db = make(client, { cache, logger, relations })
  try {
    await db.run(sql`create table users (id integer primary key, full_name text not null)`)
    await db.run(sql`create table posts (id integer primary key, title text not null, user_id integer not null)`)
    const inserted = await db.insert(users).values({ fullName: "Ada", id: 1 }).returning()
    const batch = await db.batch([
      db.insert(posts).values({ id: 1, title: "First", userId: 1 }),
      db.select().from(posts),
    ])
    const committed = await db.transaction(async (tx) => {
      await tx.insert(posts).values({ id: 2, title: "Second", userId: 1 })
      return tx.select({ title: posts.title }).from(posts).where(eq(posts.id, 2))
    })
    const rolledBack = await db.transaction(async (tx) => {
      await tx.insert(posts).values({ id: 3, title: "Third", userId: 1 })
      tx.rollback()
    }).catch((error: unknown) => error instanceof TransactionRollbackError)
    const nested = await db.query.users.findMany({ with: { posts: { orderBy: { id: "asc" } } } })
    const author = await db.query.posts.findFirst({ where: { id: 2 }, with: { author: true } })
    const rows = await db.all(sql`select id, full_name from users`)
    // `$cache` is not in drizzle-orm's types, but `drizzle()` sets it.
    await (Reflect.get(db, "$cache") as { invalidate: (options: MutationOption) => Promise<void> }).invalidate({ tables: ["users"] })
    return {
      author,
      batch,
      cacheCalls: cache.calls,
      client: db.$client === client,
      committed,
      inserted,
      nested,
      queries,
      rolledBack,
      rows,
    }
  }
  finally {
    client.close()
  }
}

afterEach(() => vi.restoreAllMocks())

describe("createLibsqlDrizzle()", () => {
  it("behaves like drizzle() from drizzle-orm/libsql", async () => {
    const expected = await exercise(makers.drizzle)
    expect(expected.nested).toEqual([{ fullName: "Ada", id: 1, posts: [{ id: 1, title: "First", userId: 1 }, { id: 2, title: "Second", userId: 1 }] }])
    expect(expected.author).toEqual({ author: { fullName: "Ada", id: 1 }, id: 2, title: "Second", userId: 1 })
    expect(expected.rows).toEqual([{ full_name: "Ada", id: 1 }])
    expect(expected.rolledBack).toBe(true)
    expect(expected.cacheCalls.length).toBeGreaterThan(0)
    expect(await exercise(makers.createLibsqlDrizzle)).toEqual(expected)
  })

  it("logs with drizzle's default logger for `logger: true`", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const logged = async (make: Make) => {
      log.mockClear()
      const client = createClient({ url: ":memory:" })
      await make(client, { logger: true }).run(sql`select ${1} as one`)
      client.close()
      return log.mock.calls
    }
    const expected = await logged(makers.drizzle)
    expect(expected).toHaveLength(1)
    expect(await logged(makers.createLibsqlDrizzle)).toEqual(expected)
  })
})
