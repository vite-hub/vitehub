import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { connectDatabase } from "@vite-hub/database/connect/node"
import { eq } from "drizzle-orm"
import { afterEach, describe, expect, it } from "vitest"

import { commentsSchema, commentsTables } from "../src/database.ts"
import { defineComments, installComments } from "../src/index.ts"
import { ada, anchor, grace } from "./harness.ts"

const directories: string[] = []

function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "vitehub-comments-"))
  directories.push(directory)
  return `file:${join(directory, "comments.sqlite")}`
}

/** Comments as `comments()` connects it: its tables, created on first use. */
function open(where: string) {
  const comments = defineComments()
  installComments(comments, { database: connectDatabase(where, { name: "comments", setup: commentsTables }) })
  return comments
}

describe("comments on a database that it connects itself", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it("creates its tables, and keeps threads when it connects again", async () => {
    const file = tempFile()
    const first = open(file)
    const [, thread] = await first.create({ page: "/pricing", anchor, body: "Too small.", author: ada })
    await first.reply(thread!.id, { body: "Agreed.", author: grace })
    await first.resolve(thread!.id, { by: grace })

    const [, threads] = await open(file).list({ page: "/pricing" })
    expect(threads).toHaveLength(1)
    expect(threads![0]).toMatchObject({ number: 1, status: "resolved", resolvedBy: grace })
    expect(threads![0]!.comments.map(comment => comment.body)).toEqual(["Too small.", "Agreed."])
  })

  it("numbers threads in order and deletes a thread with its comments", async () => {
    const comments = open(":memory:")
    await comments.create({ page: "/", anchor, body: "One.", author: ada })
    const [, second] = await comments.create({ page: "/", anchor, body: "Two.", author: ada })
    expect(second!.number).toBe(2)
    await comments.remove(second!.id)
    const [, threads] = await comments.list()
    expect(threads!.map(thread => thread.number)).toEqual([1])
  })

  it("returns inserted rows, so a pull request sync can claim a comment once", async () => {
    const database = connectDatabase(":memory:", { setup: commentsTables })
    const { vitehubCommentForge: forge } = commentsSchema
    const row = { id: "c1", threadId: "t1", repository: "acme/app", pullRequest: 7, minimized: false, updatedAt: 1 }
    const insert = () => database.insert(forge).values(row).onConflictDoNothing().returning({ id: forge.id })
    expect(await insert()).toEqual([{ id: "c1" }])
    expect(await insert()).toEqual([])
    const [found] = await database.select().from(forge).where(eq(forge.id, "c1"))
    expect(found).toMatchObject({ minimized: false, pullRequest: 7 })
  })
})
