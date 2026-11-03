import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { defineComments, defineCommentSubject, installComments } from "../src/index.ts"
import { ada, createDatabase } from "./harness.ts"

const subjects = [defineCommentSubject({ kind: "doc", scope: id => `doc:${id}` })]
const input = { subject: { kind: "doc", id: "42" }, body: "A comment", author: ada }

describe("durable scope numbers", () => {
  it.each(["thread", "first message", "scope"])("does not reuse numbers after deleting the %s", async (deletion) => {
    const database = await createDatabase()
    const comments = defineComments({ subjects })
    installComments(comments, { database })
    const threads = []
    for (let i = 0; i < 3; i++) {
      const [error, thread] = await comments.create(input)
      expect(error).toBeUndefined()
      threads.push(thread!)
    }
    const last = threads[2]!
    if (deletion === "scope") await comments.removeScope("doc:42")
    else if (deletion === "first message") await comments.removeMessage(last.messages[0]!.id)
    else await comments.remove(last.id)
    expect((await comments.getByNumber("doc:42", 3))[0]?.code).toBe("COMMENTS_NOT_FOUND")

    const restarted = defineComments({ subjects })
    installComments(restarted, { database })
    const [error, next] = await restarted.create(input)
    expect(error).toBeUndefined()
    expect(next?.n).toBe(4)
    expect((await restarted.getByNumber("doc:42", 3))[0]?.code).toBe("COMMENTS_NOT_FOUND")
    expect((await restarted.create({ ...input, subject: { kind: "doc", id: "43" } }))[1]?.n).toBe(1)
  })

  it("allocates distinct numbers to concurrent creates", async () => {
    const comments = defineComments({ subjects })
    installComments(comments, { database: await createDatabase() })
    const results = await Promise.all(Array.from({ length: 12 }, () => comments.create(input)))
    expect(results.every(([error]) => !error)).toBe(true)
    expect(results.map(([, thread]) => thread!.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it("leaves no thread when the first message cannot be stored", async () => {
    const database = await createDatabase()
    const comments = defineComments({ subjects })
    installComments(comments, { database })
    await database.run(sql`CREATE TRIGGER reject_message BEFORE INSERT ON vitehub_comment_messages BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END`)
    await expect(comments.create(input)).rejects.toThrow("fixture rejection")
    expect((await comments.list({ scope: "doc:42" }))[1]).toEqual([])
    await database.run(sql`DROP TRIGGER reject_message`)
    // The number of the failed thread is not handed out again.
    expect((await comments.create(input))[1]?.n).toBe(2)
  })
})
