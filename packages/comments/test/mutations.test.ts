import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { afterEach, describe, expect, it, vi } from "vitest"

import { commentsSchema } from "../src/database.ts"
import { defineComments, installComments } from "../src/index.ts"
import { ada, anchor, commentsMigration, grace } from "./harness.ts"

import type { CommentsDatabase } from "../src/store.ts"

const clients: ReturnType<typeof createClient>[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

async function setup(foreignKeys = false) {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.executeMultiple(commentsMigration)
  await client.execute(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`)
  // SAFETY: libSQL implements the runtime SQLite database and atomic batch contract.
  const database = drizzle(client) as unknown as CommentsDatabase
  const onComment = vi.fn()
  const comments = defineComments({ onComment })
  installComments(comments, { database })
  const [, thread] = await comments.create({ page: "/", anchor, body: "Root", author: ada })
  onComment.mockClear()

  let beforeWrite: (() => Promise<unknown>) | undefined
  const sqlOf = (statement: Parameters<typeof client.batch>[0][number]) => typeof statement === "string" ? statement : Array.isArray(statement) ? statement[0] : statement.sql
  const interleave = async (statements: Parameters<typeof client.batch>[0]) => {
    if (!beforeWrite || !statements.some(statement => /^(insert|update|delete)\b/i.test(sqlOf(statement)))) return
    const callback = beforeWrite
    beforeWrite = undefined
    await callback()
  }
  // Interleave after the runtime's preflight reads, immediately before the actual SQLite mutation or atomic batch.
  const execute = client.execute.bind(client)
  vi.spyOn(client, "execute").mockImplementation(async (statement) => {
    await interleave([statement])
    return execute(statement)
  })
  const batch = client.batch.bind(client)
  vi.spyOn(client, "batch").mockImplementation(async (statements, mode) => {
    await interleave(statements)
    return batch(statements, mode)
  })

  return { comments, database, thread: thread!, onComment, beforeWrite: (callback: () => Promise<unknown>) => { beforeWrite = callback } }
}

describe("concurrent Comments mutations", () => {
  it("rejects a reply when resolve commits after the preflight read", async () => {
    const { comments, thread, onComment, beforeWrite } = await setup()
    beforeWrite(() => comments.resolve(thread.id, { by: grace }))
    const [error, reply] = await comments.reply(thread.id, { body: "Too late", author: ada })
    expect(error?.code).toBe("COMMENTS_RESOLVED")
    expect(reply).toBeUndefined()
    expect((await comments.get(thread.id))[1]?.comments).toHaveLength(1)
    expect(onComment).not.toHaveBeenCalled()
  })

  it.each([false, true])("rejects a reply when deletion wins, with foreign keys %s", async (foreignKeys) => {
    const { comments, database, thread, onComment, beforeWrite } = await setup(foreignKeys)
    beforeWrite(() => comments.remove(thread.id))
    const [error, reply] = await comments.reply(thread.id, { body: "Too late", author: ada })
    expect(error?.code).toBe("COMMENTS_NOT_FOUND")
    expect(reply).toBeUndefined()
    expect(await database.select().from(commentsSchema.vitehubComments)).toEqual([])
    expect(onComment).not.toHaveBeenCalled()
  })

  it.each(["resolve", "reopen"] as const)("returns COMMENTS_NOT_FOUND when deletion wins before %s", async (action) => {
    const { comments, thread, beforeWrite } = await setup()
    if (action === "reopen") await comments.resolve(thread.id, { by: ada })
    beforeWrite(() => comments.remove(thread.id))
    const [error, updated] = action === "resolve" ? await comments.resolve(thread.id, { by: ada }) : await comments.reopen(thread.id)
    expect(error?.code).toBe("COMMENTS_NOT_FOUND")
    expect(updated).toBeUndefined()
  })
})
