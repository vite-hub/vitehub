import { afterEach, describe, expect, it } from "vitest"

import { readCommentsConsoleRecords } from "../src/runtime/console.ts"
import { ada, anchor, createComments, grace } from "./harness.ts"

const runtimeKey = Symbol.for("vitehub.comments.runtime")

afterEach(() => {
  Reflect.deleteProperty(globalThis, runtimeKey)
})

describe("readCommentsConsoleRecords", () => {
  it("lists open threads first, with a link to the thread and its comments as activity", async () => {
    const comments = await createComments()
    Reflect.set(globalThis, runtimeKey, comments)
    const [, open] = await comments.create({ page: "/pricing", anchor, body: "Typo here", author: ada })
    await comments.reply(open!.id, { body: "Fixed", author: grace })
    // The resolved thread has the newest activity, and still comes second.
    const [, resolved] = await comments.create({ page: "/", anchor, body: "Done already", author: ada })
    await comments.resolve(resolved!.id, { by: grace })

    const records = await readCommentsConsoleRecords()

    expect(records.map(record => record.cells.status)).toEqual(["Open", "Resolved"])
    expect(records[0]).toMatchObject({
      cells: { comment: "Typo here", page: "`/pricing`", author: "Ada", replies: "1" },
      link: { href: `/pricing?comments#comment-${open!.id}`, label: "Open on page" },
      activity: [{ author: "Ada", text: "Typo here" }, { author: "Grace", text: "Fixed" }],
    })
    expect(Date.parse(records[0]!.cells.updated!)).not.toBeNaN()
  })
})
