import { DatabaseSync } from "node:sqlite"

import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { describe, expect, it } from "vitest"

import { commentsSchema } from "../src/database.ts"
import { defineComments, installComments } from "../src/index.ts"
import { openCommentsD1 } from "../src/runtime/d1.ts"
import { openCommentsSqlite } from "../src/runtime/sqlite.ts"
import { ada, anchor, grace } from "./harness.ts"

import type { SQLInputValue } from "node:sqlite"

/** A D1 binding on an in-memory SQLite database, with D1's result shapes: `raw()` arrays, and batch rows as objects. */
function fakeD1() {
  const sqlite = new DatabaseSync(":memory:")
  const queries: string[] = []
  class Statement {
    constructor(readonly query: string, readonly values: SQLInputValue[] = []) {}
    bind(...values: unknown[]) {
      // SAFETY: Drizzle binds only the text, number, and null values of the Comments columns.
      return new Statement(this.query, values as SQLInputValue[])
    }
    prepared() {
      queries.push(this.query)
      return sqlite.prepare(this.query)
    }
    async run() {
      this.prepared().run(...this.values)
      return { success: true }
    }
    async raw() {
      const statement = this.prepared()
      statement.setReturnArrays(true)
      return statement.all(...this.values)
    }
    objects() {
      const statement = this.prepared()
      return statement.columns().length ? statement.all(...this.values) : (statement.run(...this.values), [])
    }
  }
  return {
    queries,
    binding: {
      prepare: (query: string) => new Statement(query),
      async batch(statements: Statement[]) {
        sqlite.exec("BEGIN")
        try {
          const results = statements.map(statement => ({ results: statement.objects() }))
          sqlite.exec("COMMIT")
          return results
        }
        catch (error) {
          sqlite.exec("ROLLBACK")
          throw error
        }
      },
    },
  }
}

describe("comments on Cloudflare D1", () => {
  it("creates its tables on the first query, once, and keeps threads in the binding", async () => {
    const d1 = fakeD1()
    const comments = defineComments()
    installComments(comments, { database: openCommentsD1("COMMENTS") })
    await runWithActiveCloudflareEnv({ COMMENTS: d1.binding }, async () => {
      const [, thread] = await comments.create({ page: "/pricing", anchor, body: "Too small.", author: ada })
      await comments.reply(thread!.id, { body: "Agreed.", author: grace })
      await comments.resolve(thread!.id, { by: grace })
      const [, threads] = await comments.list({ page: "/pricing" })
      expect(threads).toHaveLength(1)
      expect(threads![0]).toMatchObject({ number: 1, status: "resolved", resolvedBy: grace })
      expect(threads![0]!.comments.map(comment => comment.body)).toEqual(["Too small.", "Agreed."])
    })
    expect(d1.queries.filter(query => query.startsWith("CREATE TABLE IF NOT EXISTS `vitehub_comment_threads`"))).toHaveLength(1)
  })

  it("returns inserted rows, so a pull request sync can claim a comment once", async () => {
    const d1 = fakeD1()
    const database = openCommentsD1("COMMENTS")
    const { vitehubCommentForge: forge } = commentsSchema
    const row = { id: "c1", threadId: "t1", repository: "acme/app", pullRequest: 7, minimized: false, updatedAt: 1 }
    await runWithActiveCloudflareEnv({ COMMENTS: d1.binding }, async () => {
      const insert = () => database.insert(forge).values(row).onConflictDoNothing().returning({ id: forge.id })
      expect(await insert()).toEqual([{ id: "c1" }])
      expect(await insert()).toEqual([])
      expect(await database.select().from(forge).get()).toMatchObject({ minimized: false, pullRequest: 7 })
    })
  })

  it("uses the fallback without a binding, as on the development server", async () => {
    const comments = defineComments()
    installComments(comments, { database: openCommentsD1("COMMENTS", { fallback: () => openCommentsSqlite(":memory:") }) })
    const [, thread] = await comments.create({ page: "/", anchor, body: "Local.", author: ada })
    expect(thread!.number).toBe(1)
  })

  it("says which binding to add when the Worker has none", async () => {
    const comments = defineComments()
    installComments(comments, { database: openCommentsD1("COMMENTS") })
    await expect(runWithActiveCloudflareEnv({}, () => comments.list())).rejects.toThrow("wrangler d1 create comments --binding COMMENTS --update-config")
  })
})
