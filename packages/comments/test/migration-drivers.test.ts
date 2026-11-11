import { DatabaseSync } from "node:sqlite"

import { drizzle } from "drizzle-orm/d1"
import { SQLiteDialect } from "drizzle-orm/sqlite-core"
import { describe, expect, it } from "vitest"

import { commentsSchemaState, migrateComments } from "../src/migrate.ts"
import { liveCommentsMigration } from "./harness.ts"

import type { SQL } from "drizzle-orm"
import type { SQLInputValue } from "node:sqlite"

describe("migration driver contracts", () => {
  it.each([false, true])("rolls back synchronous SQLite transactions after DDL (failure: %s)", async (failure) => {
    const sqlite = new DatabaseSync(":memory:")
    const dialect = new SQLiteDialect()
    const query = (statement: SQL) => dialect.sqlToQuery(statement).sql
    const db = {
      all: (statement: SQL) => sqlite.prepare(query(statement)).all(),
      run: (statement: SQL) => sqlite.prepare(query(statement)).run(),
      // Like synchronous Drizzle drivers, commit when the callback returns, without awaiting it.
      transaction(run: (tx: { run: (statement: SQL) => unknown }) => unknown): unknown {
        sqlite.exec("BEGIN")
        try {
          const result = run(db)
          sqlite.exec("COMMIT")
          return result
        }
        catch (error) {
          sqlite.exec("ROLLBACK")
          throw error
        }
      },
    }
    try {
      sqlite.exec(liveCommentsMigration)
      if (failure) sqlite.exec("INSERT INTO vitehub_comment_threads (id, scope, number, page, anchor, status, created_by, created_at, updated_at) VALUES ('bad', 'pages', 1, '/', 'null', 'open', 'not json', 1, 1)")
      if (failure) {
        await expect(migrateComments(db)).rejects.toThrow()
        expect((await commentsSchemaState(db)).state).toBe("live")
        expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('vitehub_comment_threads_live', 'vitehub_comment_messages')").all()).toEqual([])
      }
      else {
        expect((await migrateComments(db)).from).toBe("live")
        expect((await commentsSchemaState(db)).state).toBe("current")
      }
    }
    finally {
      sqlite.close()
    }
  })

  it.each([false, true])("uses runnable queries in a real Drizzle D1 batch (failure: %s)", async (failure) => {
    const sqlite = new DatabaseSync(":memory:")
    // D1's binding contract, backed by SQLite so failed batches really roll back DDL.
    const binding = {
      prepare(statement: string) {
        return {
          bind(...params: SQLInputValue[]) {
            const execute = () => ({ success: true, results: sqlite.prepare(statement).all(...params) })
            return { execute, all: async () => execute() }
          },
        }
      },
      async batch(statements: Array<{ execute: () => unknown }>) {
        sqlite.exec("BEGIN")
        try {
          const results = statements.map(statement => statement.execute())
          sqlite.exec("COMMIT")
          return results
        }
        catch (error) {
          sqlite.exec("ROLLBACK")
          throw error
        }
      },
    }
    // SAFETY: the binding implements the prepare/bind/all and batch methods used by these Drizzle queries.
    const db = drizzle(binding as unknown as Parameters<typeof drizzle>[0])
    try {
      sqlite.exec(liveCommentsMigration)
      if (failure) sqlite.exec("INSERT INTO vitehub_comment_threads (id, scope, number, page, anchor, status, created_by, created_at, updated_at) VALUES ('bad', 'pages', 1, '/', 'null', 'open', 'not json', 1, 1)")
      if (failure) {
        await expect(migrateComments(db)).rejects.toThrow()
        expect((await commentsSchemaState(db)).state).toBe("live")
        expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('vitehub_comment_threads_live', 'vitehub_comment_messages')").all()).toEqual([])
      }
      else {
        expect((await migrateComments(db)).from).toBe("live")
        expect((await commentsSchemaState(db)).state).toBe("current")
      }
    }
    finally {
      sqlite.close()
    }
  })
})
