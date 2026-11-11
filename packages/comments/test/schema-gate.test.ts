import { mkdtemp, rm } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { connectDatabase } from "../src/runtime/connect/node.ts"
import { defineComments } from "../src/index.ts"
import { installComments } from "../src/install.ts"
import { commentsSchemaState } from "../src/migrate.ts"
import { createCommentsHandler } from "../src/runtime/handler.ts"
import { ada, liveCommentsMigration } from "./harness.ts"

import type { CommentsDatabase } from "../src/operations-core/store.ts"

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { force: true, recursive: true })
})

/** A SQLite file with the live-site tables of Comments 0.1.0 and one thread. */
async function liveFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "comments-schema-"))
  directories.push(directory)
  const file = join(directory, "comments.sqlite")
  const sqlite = new DatabaseSync(file)
  sqlite.exec(liveCommentsMigration)
  sqlite.prepare("INSERT INTO vitehub_comment_threads (id, scope, number, page, anchor, status, created_by, created_at, updated_at) VALUES (?, 'pages', 4, '/pricing', ?, 'open', ?, 100, 100)")
    .run("thread-1", JSON.stringify({ selector: "h1", x: 500, y: 500 }), JSON.stringify(ada))
  sqlite.prepare("INSERT INTO vitehub_comments (id, thread_id, body, mentions, author, created_at) VALUES ('comment-1', 'thread-1', 'Typo', '[]', ?, 100)").run(JSON.stringify(ada))
  sqlite.close()
  return file
}

describe("a Database that Comments opens itself", () => {
  it("moves the live-site tables of 0.1.0 before the first query, once per process", async () => {
    const file = await liveFile()
    const database = connectDatabase(`file:${file}`, { name: "comments" }) as unknown as CommentsDatabase
    const comments = defineComments({ authorize: () => true })
    installComments(comments, { database, schema: "comments" })
    // Two requests at once share one migration.
    const [[error, threads], [, again]] = await Promise.all([comments.list(), comments.list()])
    expect(error).toBeUndefined()
    expect(threads).toMatchObject([{ id: "thread-1", n: 4, subject: { kind: "page", id: "/pricing" }, messages: [{ id: "comment-1", body: "Typo" }] }])
    expect(again).toHaveLength(1)
    const [, created] = await comments.create({ page: "/pricing", body: "Next", author: ada })
    expect(created?.n).toBe(5)
    expect((await commentsSchemaState(database)).state).toBe("current")
    // The backup stays.
    const sqlite = new DatabaseSync(file)
    expect(sqlite.prepare("SELECT count(*) AS count FROM vitehub_comment_threads_live").get()).toEqual({ count: 1 })
    sqlite.close()
  })

  it("creates the tables of an empty Database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "comments-schema-"))
    directories.push(directory)
    const database = connectDatabase(`file:${join(directory, "new.sqlite")}`, { name: "comments" }) as unknown as CommentsDatabase
    const comments = defineComments({ authorize: () => true })
    installComments(comments, { database, schema: "comments" })
    const [, created] = await comments.create({ page: "/", body: "First", author: ada })
    expect(created?.n).toBe(1)
  })
})

describe("a Database that the app migrates", () => {
  it("fails with COMMENTS_R0019 and the migration to write until the tables move, then works without a restart", async () => {
    const client = createClient({ url: ":memory:" })
    await client.executeMultiple(liveCommentsMigration)
    // SAFETY: the libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
    const database = drizzle({ client }) as unknown as CommentsDatabase
    const comments = defineComments({ authorize: () => true })
    installComments(comments, { database })
    const failure = await comments.list().then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: "COMMENTS_R0019", status: 503 })
    expect(String(Reflect.get(Object(failure), "fix"))).toContain("commentsMigrationSql({ from: \"live\" })")
    expect(String(Reflect.get(Object(failure), "fix"))).toContain("https://vitehub.dev/docs/comments/configure#upgrade-to-one-model")
    // The app never gets a half-migrated Database from Comments: the old table is still there.
    expect((await commentsSchemaState(database)).state).toBe("live")

    const { migrateComments } = await import("../src/migrate.ts")
    await migrateComments(database)
    const [error, threads] = await comments.list()
    expect(error).toBeUndefined()
    expect(threads).toEqual([])
    client.close()
  })

  it("answers the overlay API with the diagnostic and status 503", async () => {
    const client = createClient({ url: ":memory:" })
    await client.executeMultiple(liveCommentsMigration)
    const comments = defineComments({ authorize: () => true })
    // SAFETY: the libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
    installComments(comments, { database: drizzle({ client }) as unknown as CommentsDatabase })
    const app = new H3().all("/api/_vitehub/comments/**", createCommentsHandler({ comments, realtime: false }))
    const response = await app.fetch(new Request("http://site.test/api/_vitehub/comments/threads?page=/"))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "COMMENTS_R0019", fix: expect.stringContaining("commentsMigrationSql") } })
    client.close()
  })

  it("names the missing columns of an outdated one-model Database", async () => {
    const client = createClient({ url: ":memory:" })
    await client.executeMultiple("CREATE TABLE `vitehub_comment_threads` (`id` text PRIMARY KEY NOT NULL, `scope` text NOT NULL, `n` integer NOT NULL, `subject_kind` text NOT NULL, `subject_id` text NOT NULL, `anchor` text NOT NULL, `status` text NOT NULL, `resolved_by` text, `resolved_at` integer, `author_id` text NOT NULL, `author_name` text, `author_image` text, `actor` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);")
    // SAFETY: the libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
    const comments = defineComments({ authorize: () => true })
    installComments(comments, { database: drizzle({ client }) as unknown as CommentsDatabase })
    const failure = await comments.get("x").then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: "COMMENTS_R0019" })
    expect(String(Reflect.get(Object(failure), "why"))).toContain("metadata, context, revision")
    client.close()
  })

  it("reads the tables once when they are current", async () => {
    const client = createClient({ url: ":memory:" })
    const { commentsMigration } = await import("./harness.ts")
    await client.executeMultiple(commentsMigration)
    const execute = vi.spyOn(client, "execute")
    // SAFETY: the libSQL Drizzle database implements the batch contract that ViteHub Databases expose.
    const comments = defineComments({ authorize: () => true })
    installComments(comments, { database: drizzle({ client }) as unknown as CommentsDatabase })
    await comments.list()
    await comments.list()
    expect(execute.mock.calls.filter(([query]) => String(Reflect.get(Object(query), "sql") ?? query).includes("pragma_table_info"))).toHaveLength(1)
    client.close()
  })
})
