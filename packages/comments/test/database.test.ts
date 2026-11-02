import { describe, expect, it } from "vitest"

import { selectCommentsDatabase } from "../src/runtime/database.ts"
import { defineCommentsPlugin } from "../src/runtime/plugin.ts"
import { defineComments } from "../src/index.ts"
import { createDatabase } from "./harness.ts"

import type { CommentsDatabase } from "../src/store.ts"

const failure = (code: string) => Object.assign(new Error(code), { code })

/** A db that throws `code` on every read until `connect()`, as ViteHub's D1 db does before a request brings the binding. */
function lazyDatabase(code: string, target?: CommentsDatabase) {
  let connected: CommentsDatabase | undefined
  const db = new Proxy({} as CommentsDatabase, {
    get(_, prop) {
      if (!connected) throw failure(code)
      const value: unknown = Reflect.get(connected, prop)
      return typeof value === "function" ? value.bind(connected) : value
    },
  })
  return { db, connect: () => { connected = target } }
}

describe("selectCommentsDatabase", () => {
  it("keeps a default Database that can't connect until the first request", () => {
    const { db } = lazyDatabase("DATABASE_MISSING_CONNECTION")
    expect(selectCommentsDatabase({ default: { db } })).toBe(db)
  })

  it("passes over the placeholder of an app without a default Database", () => {
    const main = lazyDatabase("DATABASE_MISSING_CONNECTION").db
    const placeholder = lazyDatabase("DATABASE_DISABLED").db
    expect(selectCommentsDatabase({ default: { db: placeholder }, main: { db: main } })).toBe(main)
    expect(selectCommentsDatabase({ default: { db: placeholder }, main: { db: main }, logs: { db: main } })).toBeUndefined()
  })

  it("returns the named Database", () => {
    const main = lazyDatabase("DATABASE_MISSING_CONNECTION").db
    expect(selectCommentsDatabase({ default: { db: lazyDatabase("DATABASE_DISABLED").db }, main: { db: main } }, "main")).toBe(main)
    expect(selectCommentsDatabase({ main: { db: main } }, "logs")).toBeUndefined()
  })
})

it("installs Comments on a Database that connects only once requests arrive", async () => {
  const { db, connect } = lazyDatabase("DATABASE_MISSING_CONNECTION", await createDatabase())
  const comments = defineComments()
  defineCommentsPlugin({ comments, database: () => selectCommentsDatabase({ default: { db } }), overlay: "/o.js" })(null)
  connect()
  const [error, threads] = await comments.list()
  expect(error).toBeUndefined()
  expect(threads).toEqual([])
})
