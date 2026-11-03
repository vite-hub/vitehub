import { describe, expect, it } from "vitest"

import { renderDatabaseRuntimeModule } from "../../database/src/internal/runtime-module.ts"
import { createAgentDatabase, defaultDatabaseNotConfiguredError } from "../../database/src/runtime/agent.ts"
import { selectCommentsDatabase } from "../src/runtime/database.ts"
import { defineCommentsPlugin } from "../src/runtime/plugin.ts"
import { defineComments } from "../src/index.ts"
import { createDatabase } from "./harness.ts"

import type { CommentsDatabase } from "../src/store.ts"
import type { CommentsDatabaseRegistry } from "../src/runtime/database.ts"

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
    expect(selectCommentsDatabase({ default: { db }, main: { db: lazyDatabase("DATABASE_MISSING_CONNECTION").db } })).toBe(db)
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

it("installs Comments on the sole named Database in a generated runtime registry", async () => {
  const main = await createDatabase()
  const code = renderDatabaseRuntimeModule({
    chunkParametersImport: "@vite-hub/database/drizzle",
    createAgentDatabaseImport: "@vite-hub/database/runtime/agent",
    databaseEntries: ["  main: { db: main },"],
    imports: [],
  })
  const evaluable = code.replace(/^(?:import .+|export .+ from .+)$/gm, "").replace(/^export /gm, "") + "\nreturn databases"
  const databases = new Function("main", "createAgentDatabase", "defaultDatabaseNotConfiguredError", evaluable)(
    main, createAgentDatabase, defaultDatabaseNotConfiguredError,
  ) as CommentsDatabaseRegistry

  expect(selectCommentsDatabase(databases) === main).toBe(true)
  expect(selectCommentsDatabase({ default: databases.default })).toBeUndefined()
  expect(selectCommentsDatabase({ ...databases, logs: { db: main } })).toBeUndefined()

  const comments = defineComments()
  defineCommentsPlugin({ comments, database: () => selectCommentsDatabase(databases), overlay: "/o.js" })(null)
  const [error, threads] = await comments.list()
  expect(error).toBeUndefined()
  expect(threads).toEqual([])
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
