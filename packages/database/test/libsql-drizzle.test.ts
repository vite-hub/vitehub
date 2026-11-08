import { createClient } from "@libsql/client"
import { eq, relations, sql, TransactionRollbackError } from "drizzle-orm"
import { Cache } from "drizzle-orm/cache/core"
import { drizzle } from "drizzle-orm/libsql"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createLibsqlDrizzle } from "../src/runtime/libsql-drizzle.ts"

import type { Client } from "@libsql/client"
import type { DrizzleConfig, Logger } from "drizzle-orm"
import type { MutationOption } from "drizzle-orm/cache/core"

const users = sqliteTable("users", {
  fullName: text().notNull(),
  id: integer().primaryKey(),
})
const posts = sqliteTable("posts", {
  id: integer().primaryKey(),
  title: text().notNull(),
  userId: integer().notNull(),
})
const schema = {
  posts,
  postsRelations: relations(posts, ({ one }) => ({ author: one(users, { fields: [posts.userId], references: [users.id] }) })),
  users,
  usersRelations: relations(users, ({ many }) => ({ posts: many(posts) })),
}

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

type Make = (client: Client, config: DrizzleConfig<typeof schema>) => ReturnType<typeof createLibsqlDrizzle<typeof schema>>

const makers: Record<"drizzle" | "createLibsqlDrizzle", Make> = {
  createLibsqlDrizzle: (client, config) => createLibsqlDrizzle(client, config),
  drizzle: (client, config) => drizzle(client, config),
}

async function exercise(make: Make) {
  const client = createClient({ url: ":memory:" })
  const queries: unknown[] = []
  const logger: Logger = { logQuery: (query, params) => queries.push([query, params]) }
  const cache = new RecordingCache()
  const db = make(client, { cache, casing: "snake_case", logger, schema })
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
    const nested = await db.query.users.findMany({ with: { posts: { orderBy: posts.id } } })
    const author = await db.query.posts.findFirst({ where: eq(posts.id, 2), with: { author: true } })
    await db.$cache.invalidate({ tables: ["users"] })
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
