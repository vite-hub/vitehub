import { readFileSync } from "node:fs"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { describe, expect, it } from "vitest"

import { defineComments, installComments } from "../src/index.ts"
import { ada, anchor } from "./harness.ts"

import type { CommentsDatabase } from "../src/store.ts"

const migrations = new URL("../../../playground/content/server/databases/content/migrations/", import.meta.url)
const migration = (name: string) => readFileSync(new URL(name, migrations), "utf8")
const guide = readFileSync(new URL("../../../docs/content/docs/comments/configure.md", import.meta.url), "utf8")
function documentedSql(name: string): string {
  const start = guide.indexOf(`\x60\x60\x60sql [${name}]\n`)
  if (start < 0) throw new Error(`Missing migration instructions: ${name}`)
  return guide.slice(guide.indexOf("\n", start) + 1, guide.indexOf("\x60\x60\x60", start + 3))
}

async function oldDatabase() {
  const client = createClient({ url: ":memory:" })
  await client.executeMultiple(migration("0002_comments.sql") + "\n" + migration("0003_comments_context.sql"))
  for (const id of ["c", "a", "b"]) {
    await client.execute({ sql: "INSERT INTO vitehub_comment_threads (id,page,anchor,status,created_by,created_at,updated_at) VALUES (?, '/', ?, 'open', ?, 100, 100)", args: [id, JSON.stringify(anchor), JSON.stringify(ada)] })
    await client.execute({ sql: "INSERT INTO vitehub_comments (id,thread_id,body,mentions,author,created_at) VALUES (?, ?, 'Original comment', '[]', ?, 100)", args: [`comment-${id}`, id, JSON.stringify(ada)] })
  }
  return client
}

describe("scope upgrades for existing databases", () => {
  it.each(["consumer guide", "playground migrations"])("backfills before the unique index using %s", async (path) => {
    const client = await oldDatabase()
    try {
      if (path === "consumer guide") {
        const statements = migration("0004_comments_scope.sql").split("--> statement-breakpoint")
        await client.executeMultiple(statements.slice(0, 3).join("\n"))
        await client.executeMultiple(documentedSql("scope-number-backfill.sql"))
        await client.executeMultiple(statements.at(-1)!)
        await client.executeMultiple(migration("0005_comments_scope_counters.sql").split("--> statement-breakpoint")[0]!)
        await client.executeMultiple(documentedSql("scope-counter-backfill.sql"))
      }
      else {
        await client.executeMultiple(migration("0004_comments_scope.sql"))
        await client.executeMultiple(migration("0005_comments_scope_counters.sql"))
      }
      const rows = await client.execute("SELECT id, number FROM vitehub_comment_threads ORDER BY number")
      expect(rows.rows.map(row => [row.id, row.number])).toEqual([["a", 1], ["b", 2], ["c", 3]])
      expect((await client.execute("SELECT count(*) AS count FROM vitehub_comments")).rows[0]?.count).toBe(3)
      const comments = defineComments()
      // SAFETY: libSQL implements the same Drizzle atomic batch contract as the Database runtime.
      installComments(comments, { database: drizzle(client) as unknown as CommentsDatabase })
      await comments.removeScope("pages")
      expect((await comments.create({ page: "/", anchor, body: "New conversation", author: ada }))[1]?.number).toBe(4)
      expect((await comments.getByNumber("pages", 3))[0]?.code).toBe("COMMENTS_NOT_FOUND")
      // Reapplying the seed must not lower a counter after its highest thread was deleted.
      await comments.removeScope("pages")
      await client.executeMultiple(documentedSql("scope-counter-backfill.sql"))
      expect((await comments.create({ page: "/", anchor, body: "Another conversation", author: ada }))[1]?.number).toBe(5)
    }
    finally {
      client.close()
    }
  })
})
