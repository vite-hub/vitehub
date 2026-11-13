import { readFileSync } from "node:fs"

import { createClient } from "@libsql/client"
import { createOperationRegistry, runOperation } from "@vite-hub/internal/operations"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it } from "vitest"

import { commentsMigrationSql, commentsSchemaState, migrateComments } from "../src/database.ts"
import { defineComments, defineCommentSubject } from "../src/index.ts"
import { installComments } from "../src/install.ts"
import { commentsOperations } from "../src/operations.ts"
import { installCommentsRuntime } from "../src/operations-core/server.ts"
import { createCommentsStore } from "../src/operations-core/store.ts"
import { ada, anchor, grace, liveCommentsMigration } from "./harness.ts"

import type { CommentsDatabase } from "../src/operations-core/store.ts"

const clients: ReturnType<typeof createClient>[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  installCommentsRuntime(() => { throw new Error("not installed") })
})

const guest = { id: "guest:7", name: "Visitor", guest: true }
const legacyGuest = { id: ada.id, name: "Guest Ada", image: "/guest.png", guest: true }
const migratedGuest = { ...legacyGuest, id: `guest:${legacyGuest.id}` }
const context = { url: "https://example.com/pricing", components: [{ name: "PricingCard" }] }

/** A Database with the tables of the live-site model and threads that it wrote. */
async function liveDatabase() {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.executeMultiple(liveCommentsMigration)
  const thread = (id: string, scope: string, number: number, page: string, threadAnchor: unknown, extra: { metadata?: unknown, context?: unknown, status?: string, resolvedBy?: unknown, author?: unknown, at?: number } = {}) => client.execute({
    sql: "INSERT INTO vitehub_comment_threads (id, scope, number, page, anchor, context, metadata, status, created_by, resolved_by, resolved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [id, scope, number, page, JSON.stringify(threadAnchor), extra.context ? JSON.stringify(extra.context) : null, extra.metadata ? JSON.stringify(extra.metadata) : null, extra.status ?? "open", JSON.stringify(extra.author ?? ada), extra.resolvedBy ? JSON.stringify(extra.resolvedBy) : null, extra.resolvedBy ? 300 : null, extra.at ?? 100, extra.at ?? 100],
  })
  const comment = (id: string, threadId: string, body: string, author: unknown, mentions: unknown[] = [], at = 100) => client.execute({
    sql: "INSERT INTO vitehub_comments (id, thread_id, body, mentions, author, created_at, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [id, threadId, body, JSON.stringify(mentions), JSON.stringify(author), at, id === "c2" ? 250 : null],
  })
  await thread("t1", "pages", 1, "/pricing", anchor, { context, status: "resolved", resolvedBy: grace })
  await comment("c1", "t1", "The price is wrong", ada)
  await comment("c2", "t1", "@Ada fixed", grace, [{ id: "ada", name: "Ada" }], 200)
  await thread("t2", "pages", 3, "/", { ...anchor, field: "about#hero.title" }, { author: guest, at: 150 })
  await comment("c3", "t2", "From a guest", guest, [], 150)
  await thread("t3", "drop:42", 1, "/d/42", null, { metadata: { dropId: "42", version: 2, quote: null } })
  await comment("c4", "t3", "On the doc", ada)
  await thread("t4", "pages", 4, "/guest", anchor, { author: legacyGuest })
  await comment("c5", "t4", "A guest with a signed-in person's id", legacyGuest)
  // The scope handed out number 5 before its thread went away.
  await client.execute("INSERT INTO vitehub_comment_scope_counters (scope, last_number) VALUES ('pages', 5), ('drop:42', 1)")
  await client.execute("INSERT INTO vitehub_comment_forge (id, thread_id, repository, pull_request, remote_id, updated_at) VALUES ('c1', 't1', 'acme/site', 7, '99', 100)")
  // SAFETY: libSQL implements the batch contract of the Database runtime.
  return { client, db: drizzle({ client }) as unknown as CommentsDatabase }
}

const subjects = [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })]

async function expectMigrated(db: CommentsDatabase) {
  const comments = defineComments({ subjects })
  installComments(comments, { database: db })
  const [, pricing] = await comments.get("t1")
  expect(pricing).toMatchObject({
    id: "t1",
    scope: "site",
    n: 1,
    subject: { kind: "page", id: "/pricing" },
    anchor: { ...anchor, kind: "element" },
    context,
    status: "resolved",
    resolvedBy: grace,
    resolvedAt: 300,
    author: ada,
    createdAt: 100,
  })
  expect(pricing!.messages).toEqual([
    { id: "c1", threadId: "t1", body: "The price is wrong", author: ada, mentions: [], attachments: [], createdAt: 100 },
    { id: "c2", threadId: "t1", body: "@Ada fixed", author: grace, mentions: ["ada"], attachments: [], createdAt: 200, editedAt: 250 },
  ])
  const [, fromGuest] = await comments.get("t2")
  expect(fromGuest).toMatchObject({ n: 3, author: guest, anchor: { kind: "element", field: "about#hero.title" }, messages: [{ author: guest }] })
  const [, legacy] = await comments.get("t4")
  expect(legacy).toMatchObject({ author: migratedGuest, messages: [{ id: "c5", author: migratedGuest }] })
  const registry = createOperationRegistry([{ operations: commentsOperations }])
  installCommentsRuntime({ definition: { authorize: ({ action }) => action !== "delete" }, store: createCommentsStore(db) })
  for (const [name, input] of [
    ["comments.edit", { threadId: "t4", messageId: "c5", body: "Impersonated" }],
    ["comments.delete", { threadId: "t4", messageId: "c5" }],
    ["comments.delete", { threadId: "t4" }],
  ] as const) {
    expect(await runOperation(registry, name, input, { access: { mode: "auth", sections: "all" }, surface: "console", user: ada }))
      .toMatchObject({ ok: false, status: 403, code: name === "comments.edit" ? "COMMENTS_R0004" : "COMMENTS_R0009" })
  }
  const [, drop] = await comments.get("t3")
  expect(drop).toMatchObject({ scope: "drop:42", n: 1, subject: { kind: "drop", id: "42" }, anchor: { kind: "page" }, metadata: { dropId: "42", version: 2, quote: null } })
  // Numbers continue after the highest one that each scope handed out, also on the new kinds of subject.
  expect((await comments.create({ page: "/", anchor, body: "New", author: ada }))[1]?.n).toBe(6)
  expect((await comments.create({ subject: { kind: "drop", id: "42" }, body: "New", author: ada }))[1]?.n).toBe(2)
  // A pull request link names a message, so it follows the message.
  expect((await comments.getByMessage("c1"))[1]?.id).toBe("t1")
  return comments
}

describe("migrateComments", () => {
  it.each(["runtime", "playground"])("remaps page numbers beyond an existing site's high-water mark via %s", async (migration) => {
    const { client, db } = await liveDatabase()
    await client.execute("INSERT INTO vitehub_comment_threads (id, scope, number, page, anchor, status, created_by, created_at, updated_at) VALUES ('custom', 'site', 1, '/custom', 'null', 'open', '{\"id\":\"ada\"}', 1, 1)")
    await client.execute("INSERT INTO vitehub_comment_scope_counters (scope, last_number) VALUES ('site', 8)")
    if (migration === "runtime") await migrateComments(db)
    else {
      for (const folder of ["20261103111846_comments_one_model", "20261109045320_comments_request_id"]) {
        await client.executeMultiple(readFileSync(new URL(`../../../playground/content/server/databases/content/migrations/${folder}/migration.sql`, import.meta.url), "utf8").replaceAll("--> statement-breakpoint", ""))
      }
    }
    const comments = defineComments({ subjects })
    installComments(comments, { database: db })
    expect((await comments.get("custom"))[1]).toMatchObject({ scope: "site", n: 1, subject: { kind: "site", id: "/custom" } })
    expect((await comments.get("t1"))[1]).toMatchObject({ scope: "site", n: 9, subject: { kind: "page", id: "/pricing" }, messages: [{ id: "c1" }, { id: "c2" }] })
    // The deleted pages#5 still reserves its number after the offset of eight.
    expect((await comments.create({ page: "/", body: "Next", author: ada }))[1]?.n).toBe(14)
    expect((await client.execute("SELECT number FROM vitehub_comment_threads_live WHERE id = 't1'")).rows[0]?.number).toBe(1)
  })

  it.each(["batch", "transaction"])("moves the live-site tables to one model, and keeps the old tables via %s", async (driver) => {
    const { client, db } = await liveDatabase()
    expect((await commentsSchemaState(db)).state).toBe("live")
    const target = driver === "batch" ? db : { all: db.all.bind(db), run: db.run.bind(db), transaction: db.transaction.bind(db) }
    const migration = await migrateComments(target)
    expect(migration).toMatchObject({ from: "live", backup: "vitehub_comment_threads_live" })
    await expectMigrated(db)
    expect((await client.execute("SELECT count(*) AS count FROM vitehub_comment_threads_live")).rows[0]?.count).toBe(4)
    expect((await client.execute("SELECT count(*) AS count FROM vitehub_comments")).rows[0]?.count).toBe(5)
    expect((await client.execute("SELECT count(*) AS count FROM vitehub_comment_scope_counters")).rows[0]?.count).toBe(2)
  })

  it("does nothing the second time", async () => {
    const { client, db } = await liveDatabase()
    await migrateComments(db)
    const comments = defineComments({ subjects })
    installComments(comments, { database: db })
    await comments.remove("t3")
    expect(await migrateComments(db)).toEqual({ from: "current", statements: [] })
    expect((await comments.get("t3"))[0]?.code).toBe("COMMENTS_NOT_FOUND")
    expect((await client.execute("SELECT count(*) AS count FROM vitehub_comment_threads")).rows[0]?.count).toBe(3)
  })

  it.each(["batch", "transaction"])("changes nothing when a statement fails via %s", async (driver) => {
    const { client, db } = await liveDatabase()
    await client.execute("INSERT INTO vitehub_comment_threads (id, scope, number, page, anchor, status, created_by, created_at, updated_at) VALUES ('bad', 'pages', 9, '/', 'null', 'open', 'not json', 1, 1)")
    const target = driver === "batch" ? db : { all: db.all.bind(db), run: db.run.bind(db), transaction: db.transaction.bind(db) }
    await expect(migrateComments(target)).rejects.toThrow()
    expect((await commentsSchemaState(db)).state).toBe("live")
    expect((await client.execute("SELECT name FROM sqlite_master WHERE name = 'vitehub_comment_messages'")).rows).toEqual([])
  })

  it("gives the same result as the SQL for a custom migration file", async () => {
    const { client, db } = await liveDatabase()
    await client.executeMultiple(commentsMigrationSql({ from: "live" }).map(statement => `${statement};`).join("\n"))
    await expectMigrated(db)
  })

  it("adds the columns of this version to the tables of an earlier one", async () => {
    const client = createClient({ url: ":memory:" })
    clients.push(client)
    await client.executeMultiple([
      "CREATE TABLE vitehub_comment_threads (id text PRIMARY KEY NOT NULL, scope text NOT NULL, n integer NOT NULL, subject_kind text NOT NULL, subject_id text NOT NULL, anchor text NOT NULL, status text NOT NULL, resolved_by text, resolved_at integer, author_id text NOT NULL, author_name text, author_image text, actor text, created_at integer NOT NULL, updated_at integer NOT NULL);",
      "CREATE TABLE vitehub_comment_messages (id text PRIMARY KEY NOT NULL, thread_id text NOT NULL, body text NOT NULL, author_id text NOT NULL, author_name text, author_image text, actor text, mentions text NOT NULL, attachments text NOT NULL, created_at integer NOT NULL, edited_at integer);",
      "CREATE TABLE vitehub_comment_counters (scope text PRIMARY KEY NOT NULL, next integer NOT NULL);",
      "INSERT INTO vitehub_comment_threads VALUES ('t', 'site', 1, 'page', '/', '{\"kind\":\"page\"}', 'open', NULL, NULL, 'ada', 'Ada', NULL, NULL, 1, 1);",
    ].join("\n"))
    // SAFETY: libSQL implements the batch contract of the Database runtime.
    const db = drizzle({ client }) as unknown as CommentsDatabase
    expect(await commentsSchemaState(db)).toEqual({ state: "outdated", missing: ["metadata", "context", "revision", "request_id"] })
    expect((await migrateComments(db)).from).toBe("outdated")
    expect(await commentsSchemaState(db)).toEqual({ state: "current", missing: [] })
    expect((await migrateComments(db)).statements).toEqual([])
    expect((await client.execute("SELECT name FROM sqlite_master WHERE name = 'vitehub_comment_threads_scope_request'")).rows).toHaveLength(1)
    const comments = defineComments()
    installComments(comments, { database: db })
    expect((await comments.get("t"))[1]).toMatchObject({ n: 1, subject: { kind: "page", id: "/" } })
  })

  it("leaves an empty Database to the tables of the build", async () => {
    const client = createClient({ url: ":memory:" })
    clients.push(client)
    // SAFETY: libSQL implements the batch contract of the Database runtime.
    const db = drizzle({ client }) as unknown as CommentsDatabase
    expect(await migrateComments(db)).toEqual({ from: "empty", statements: [] })
    expect((await client.execute("SELECT name FROM sqlite_master")).rows).toEqual([])
  })

  it("adds the columns on Postgres in one transaction, and has no live-site tables to move there", async () => {
    const ran: string[] = []
    let inTransaction = false
    const text = (query: ReturnType<typeof sql.raw>) => query.queryChunks.map(chunk => Reflect.get(Object(chunk), "value")).flat().join("")
    const postgres = {
      execute: async (query: ReturnType<typeof sql.raw>) => {
        const statement = text(query)
        if (statement.includes("information_schema")) return { rows: ["id", "scope", "n", "subject_kind", "metadata"].map(column_name => ({ column_name })) }
        expect(inTransaction).toBe(true)
        ran.push(statement)
        return { rows: [] }
      },
      transaction: async (run: (tx: unknown) => Promise<void>) => {
        inTransaction = true
        await run(postgres)
        inTransaction = false
      },
    }
    const migration = await migrateComments(postgres, { dialect: "postgresql" })
    expect(migration.from).toBe("outdated")
    expect(ran.slice(0, 5)).toEqual([
      "ALTER TABLE \"vitehub_comment_threads\" ADD COLUMN IF NOT EXISTS \"metadata\" text",
      "ALTER TABLE \"vitehub_comment_threads\" ADD COLUMN IF NOT EXISTS \"context\" text",
      "ALTER TABLE \"vitehub_comment_threads\" ADD COLUMN IF NOT EXISTS \"revision\" bigint",
      "ALTER TABLE \"vitehub_comment_threads\" ADD COLUMN IF NOT EXISTS \"request_id\" text",
      "CREATE UNIQUE INDEX IF NOT EXISTS \"vitehub_comment_threads_scope_request\" ON \"vitehub_comment_threads\" (\"scope\",\"request_id\")",
    ])
    expect(ran.some(statement => statement.startsWith("CREATE TABLE IF NOT EXISTS \"vitehub_comment_forge\""))).toBe(true)
    expect(() => commentsMigrationSql({ dialect: "postgresql", from: "live" })).toThrow("no Postgres tables")
  })
})

describe("the custom migration of a ViteHub Database", () => {
  const migrations = new URL("../../../playground/content/server/databases/content/migrations/", import.meta.url)
  const migration = (folder: string) => readFileSync(new URL(`${folder}/migration.sql`, migrations), "utf8")

  it.each([ada, guest, legacyGuest])("moves authors %j from the playground's live-site migrations", async (author) => {
    const client = createClient({ url: ":memory:" })
    clients.push(client)
    for (const name of ["20261023103000_comments", "20261026080000_comments_context", "20261027080000_comments_scope", "20261027200000_comments_scope_counters"]) {
      await client.executeMultiple(migration(name).replaceAll("--> statement-breakpoint", ""))
    }
    await client.execute({ sql: "INSERT INTO vitehub_comment_threads (id, scope, number, page, anchor, status, created_by, created_at, updated_at) VALUES ('t', 'pages', 2, '/', ?, 'open', ?, 1, 1)", args: [JSON.stringify(anchor), JSON.stringify(author)] })
    await client.execute({ sql: "INSERT INTO vitehub_comments (id, thread_id, body, mentions, author, created_at) VALUES ('c', 't', 'Hello', '[]', ?, 1)", args: [JSON.stringify(author)] })
    for (const folder of ["20261103111846_comments_one_model", "20261109045320_comments_request_id"]) {
      await client.executeMultiple(migration(folder).replaceAll("--> statement-breakpoint", ""))
    }
    // SAFETY: libSQL implements the batch contract of the Database runtime.
    const db = drizzle({ client }) as unknown as CommentsDatabase
    expect((await commentsSchemaState(db)).state).toBe("current")
    const comments = defineComments()
    installComments(comments, { database: db })
    const expectedAuthor = author === legacyGuest ? migratedGuest : author
    expect((await comments.get("t"))[1]).toMatchObject({ n: 2, subject: { kind: "page", id: "/" }, author: expectedAuthor, messages: [{ id: "c", body: "Hello", author: expectedAuthor }] })
    expect((await comments.create({ page: "/", anchor, body: "Next", author: ada }))[1]?.n).toBe(3)
  })
})
