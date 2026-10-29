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

  it("keeps a concurrent resolution when replying with allowResolved", async () => {
    const { comments, thread, onComment, beforeWrite } = await setup()
    beforeWrite(() => comments.resolve(thread.id, { by: grace }))
    const [error, reply] = await comments.reply(thread.id, { body: "Follow-up", author: ada }, { allowResolved: true })
    expect(error).toBeUndefined()
    expect(reply?.body).toBe("Follow-up")
    const [, updated] = await comments.get(thread.id)
    expect(updated).toMatchObject({ status: "resolved", resolvedBy: grace, resolvedAt: expect.any(String) })
    expect(updated?.comments).toHaveLength(2)
    expect(onComment).toHaveBeenCalledTimes(1)
    expect(onComment).toHaveBeenCalledWith({ thread: updated, comment: reply, mentions: reply!.mentions })
  })

  it.each([[false, false], [false, true], [true, false], [true, true]])("rejects a reply when deletion wins, with foreign keys %s and allowResolved %s", async (foreignKeys, allowResolved) => {
    const { comments, database, thread, onComment, beforeWrite } = await setup(foreignKeys)
    beforeWrite(() => comments.remove(thread.id))
    const [error, reply] = await comments.reply(thread.id, { body: "Too late", author: ada }, { allowResolved })
    expect(error?.code).toBe("COMMENTS_NOT_FOUND")
    expect(reply).toBeUndefined()
    expect(await database.select().from(commentsSchema.vitehubComments)).toEqual([])
    expect(onComment).not.toHaveBeenCalled()
  })

  it("returns not found and leaves thread activity unchanged when deletion beats an edit", async () => {
    const { comments, thread, beforeWrite } = await setup()
    const [, reply] = await comments.reply(thread.id, { body: "Before", author: ada })
    const [, before] = await comments.get(thread.id)
    beforeWrite(() => comments.removeComment(reply!.id))
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000)
    try {
      const [error, edited] = await comments.edit(reply!.id, { body: "After" })
      expect(error?.code).toBe("COMMENTS_NOT_FOUND")
      expect(edited).toBeUndefined()
      const [, after] = await comments.get(thread.id)
      expect(after?.updatedAt).toBe(before?.updatedAt)
      expect(after?.comments.map(comment => comment.body)).toEqual(["Root"])
    }
    finally { clock.mockRestore() }
  })

  it.each([false, true])("counts all threads deleted from a scope when creation races, with foreign keys %s", async (foreignKeys) => {
    const { comments, database, beforeWrite } = await setup(foreignKeys)
    const [, other] = await comments.create({ scope: "private", page: "/", body: "Keep", author: ada })
    beforeWrite(() => comments.create({ page: "/", anchor, body: "Concurrent", author: grace }))
    expect(await comments.removeScope("pages")).toEqual([undefined, { removed: 2 }])
    expect((await comments.list({ scope: "pages" }))[1]).toEqual([])
    expect((await comments.get(other!.id))[1]?.comments[0]?.body).toBe("Keep")
    expect(await database.select().from(commentsSchema.vitehubComments)).toHaveLength(1)
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
