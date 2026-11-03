import { sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"

import { defineComments, installComments } from "../src/index.ts"
import { ada, createDatabase } from "./harness.ts"

const input = { scope: "doc:42", page: "/docs/42", body: "A comment", author: ada }

describe("durable scope numbers", () => {
  it.each(["thread", "first comment", "scope"])("does not reuse numbers after deleting the %s", async (deletion) => {
    const database = await createDatabase()
    const comments = defineComments()
    installComments(comments, { database })
    const threads = []
    for (let i = 0; i < 3; i++) {
      const [error, thread] = await comments.create(input)
      expect(error).toBeUndefined()
      threads.push(thread!)
    }
    const last = threads[2]!
    if (deletion === "scope") await comments.removeScope(input.scope)
    else if (deletion === "first comment") await comments.removeComment(last.comments[0]!.id)
    else await comments.remove(last.id)
    expect((await comments.getByNumber(input.scope, 3))[0]?.code).toBe("COMMENTS_NOT_FOUND")

    const restarted = defineComments()
    installComments(restarted, { database })
    const [error, next] = await restarted.create(input)
    expect(error).toBeUndefined()
    expect(next?.number).toBe(4)
    expect((await restarted.getByNumber(input.scope, 3))[0]?.code).toBe("COMMENTS_NOT_FOUND")
    expect((await restarted.create({ ...input, scope: "doc:43" }))[1]?.number).toBe(1)
  })

  it("allocates distinct numbers to concurrent creates", async () => {
    const comments = defineComments()
    installComments(comments, { database: await createDatabase() })
    const results = await Promise.all(Array.from({ length: 12 }, () => comments.create(input)))
    expect(results.every(([error]) => !error)).toBe(true)
    expect(results.map(([, thread]) => thread!.number).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
  })

  it("rolls back allocation and the thread when the first comment cannot be stored", async () => {
    const database = await createDatabase()
    const comments = defineComments()
    installComments(comments, { database })
    await database.run(sql`CREATE TRIGGER reject_comment BEFORE INSERT ON vitehub_comments BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END`)
    await expect(comments.create(input)).rejects.toThrow("fixture rejection")
    expect((await comments.list({ scope: input.scope }))[1]).toEqual([])
    await database.run(sql`DROP TRIGGER reject_comment`)
    expect((await comments.create(input))[1]?.number).toBe(1)
  })
})
