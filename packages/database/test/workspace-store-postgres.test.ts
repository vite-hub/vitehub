import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { resolveWorkspaceStoreTarget } from "../../workspace/src/storage/target.ts"
import { postgresHistoryIndex } from "../../workspace/src/storage/history-index-postgres.ts"
import { createBlobDatabaseWorkspaceStore } from "../../workspace/src/blob-database.ts"
import { workspaceHistorySchema } from "../../workspace/src/blob-database/postgres.ts"
import { defineDatabase } from "../src/definition.ts"
import { createNodePostgresDatabase } from "../src/runtime/node-postgres.ts"
import { createDevPostgresDatabase } from "../src/runtime/pglite.ts"
import { createPostgresDatabase } from "../src/runtime/postgres.ts"
import { db as defaultDb } from "../src/runtime/registry.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { BlobDatabaseWorkspaceStore } from "../../workspace/src/blob-database.ts"

const useDatabase = vi.fn()
vi.mock("@vite-hub/database/runtime/registry", () => ({ useDatabase }))
const { getRuntimeDatabases } = vi.hoisted(() => ({ getRuntimeDatabases: vi.fn() }))
vi.mock("../src/runtime/drizzle-runtime.ts", () => ({ getRuntimeDatabases }))

const url = process.env.VITEHUB_TEST_POSTGRES_URL
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function historyMigration(): Promise<string[]> {
  return await generateMigration(await generateDrizzleJson({}), await generateDrizzleJson(workspaceHistorySchema))
}

async function sharedBlob(): Promise<BlobStorage> {
  const root = await mkdtemp(join(tmpdir(), "vitehub-workspace-postgres-"))
  cleanup.push(() => rm(root, { force: true, recursive: true }))
  return createBlobStorage(createDriver({ driver: "fs", base: root }))
}

async function text(store: BlobDatabaseWorkspaceStore, id: string, path: string) {
  return await (await store.history.open(id)).readFile(path, { encoding: "utf8" })
}

describe("Blob + Database Store on PGlite", () => {
  beforeEach(() => {
    useDatabase.mockReset()
  })

  it("explains how to apply missing Postgres history migrations and retries after they run", async () => {
    const { db, migrate } = await historyDatabase()
    const store = createBlobDatabaseWorkspaceStore({ blob: await sharedBlob(), database: db, workspace: "handbook" })

    await expect(store.history.head()).rejects.toMatchObject({
      code: "WORKSPACE_POSTGRES_HISTORY_SCHEMA_MISSING",
      fix: expect.stringContaining("vitehub database migrate"),
      cause: { cause: { code: "42P01" } },
    })

    await migrate()
    await expect(store.history.head()).resolves.toBeNull()
  })

  it("applies the Postgres history schema and keeps history by Database name", async () => {
    const db = await migratedDatabase()
    useDatabase.mockImplementation((name: string) => {
      if (name !== "history") throw new Error(`Unknown Database ${name}`)
      return { db }
    })

    const store = createBlobDatabaseWorkspaceStore({ blob: await sharedBlob(), database: "history", workspace: "handbook" })
    expect(useDatabase).not.toHaveBeenCalled()
    const first = await store.history.commit({ ifHead: null, files: { "docs/a.md": { content: "one", path: "docs/a.md" }, "docs/100%_b.md": { content: "two", path: "docs/100%_b.md" } }, message: "first" })
    const second = await store.history.commit({ ifHead: first.id, changes: { put: { "docs/a.md": { content: "three", path: "docs/a.md" } } } })
    const draft = await store.history.commit({ ref: "draft", ifHead: null, files: { "draft.md": { content: "draft", path: "draft.md" } } })

    await expect(resolveWorkspaceStoreTarget(store)).resolves.toMatchObject({ dialect: "postgresql", provider: "blob-database" })
    expect(await store.history.head()).toEqual(second)
    expect(await text(store, second.id, "docs/a.md")).toBe("three")
    expect(await text(store, second.id, "docs/100%_b.md")).toBe("two")
    expect((await store.history.list({ path: "docs/a.md" })).revisions.map(revision => revision.id)).toEqual([second.id, first.id])
    expect((await store.history.list({ path: "docs/100%_b.md" })).revisions.map(revision => revision.id)).toEqual([first.id])
    expect((await store.history.list({ limit: 1 })).cursor).toBe(second.id)
    expect((await store.history.refs()).map(ref => [ref.name, ref.head.id])).toEqual([["draft", draft.id], ["main", second.id]])
    expect(await store.history.usage()).toEqual({ bytes: 16, objects: 4 })

    await store.setMeta?.("owner", { name: "docs" })
    expect(await store.getMeta?.("owner")).toEqual({ name: "docs" })
    await store.setMeta?.("owner", null)
    expect(await store.getMeta?.("owner")).toBeNull()
    await store.setMeta?.("owner", undefined)
    expect(await store.getMeta?.("owner")).toBeUndefined()

    await expect(store.history.deleteRef?.({ ref: "draft", ifHead: draft.id })).resolves.toBe(true)
    expect(await store.history.usage()).toEqual({ bytes: 11, objects: 3 })
    await store.delete()
    expect(await store.history.head()).toBeNull()
    expect(await store.history.usage()).toEqual({ bytes: 0, objects: 0 })
    await expect(store.history.commit({ ifHead: null, files: {} })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
  })

  it("queries and deletes revisions containing opaque JSON file metadata", async () => {
    const store = createBlobDatabaseWorkspaceStore({ blob: await sharedBlob(), database: await migratedDatabase(), workspace: "handbook" })
    const file = { content: "draft", path: "draft.md", metadata: { note: "a\u0000b", nested: { "\u0000": "\ud800" } } }
    const first = await store.history.commit({ ref: "draft", ifHead: null, files: { "draft.md": file } })
    const second = await store.history.commit({ ref: "draft", ifHead: first.id, files: { "draft.md": { ...file, metadata: { nested: file.metadata.nested, note: file.metadata.note } } } })
    expect((await (await store.history.open(second.id)).stat("draft.md"))?.metadata).toEqual(file.metadata)
    expect((await store.history.list({ ref: "draft", path: "draft.md" })).revisions.map(revision => revision.id)).toEqual([first.id])
    expect(await store.history.usage()).toEqual({ bytes: 5, objects: 1 })
    await expect(store.history.deleteRef?.({ ref: "draft", ifHead: second.id })).resolves.toBe(true)
    expect(await store.history.usage()).toEqual({ bytes: 0, objects: 0 })
  })

  it("uses the lazy default Database as an object or factory result", async () => {
    const db = await migratedDatabase()
    getRuntimeDatabases.mockReturnValue({ databases: { default: { db } } })
    const blob = await sharedBlob()
    const direct = createBlobDatabaseWorkspaceStore({ blob, database: defaultDb, workspace: "handbook" })
    const factory = createBlobDatabaseWorkspaceStore({ blob, database: () => defaultDb, workspace: "handbook" })
    expect(getRuntimeDatabases).not.toHaveBeenCalled()
    const head = await direct.history.commit({ ifHead: null, files: {} })
    expect(await factory.history.head()).toEqual(head)
  })

  it("registers more objects than can fit in one parameter per column", async () => {
    const index = postgresHistoryIndex(await migratedDatabase())
    const workspace = await index.claim("handbook", undefined)
    const objects = Array.from({ length: 22_000 }, (_, item) => {
      const digest = item.toString(16).padStart(64, "0")
      return { digest, key: `${digest}-generation`, size: 1 }
    })
    await index.register(workspace, objects)
    expect(await index.objectKeys(workspace, objects.map(object => object.digest))).toHaveLength(objects.length)
  }, 30_000)
})

async function migratedDatabase() {
  const { db, migrate } = await historyDatabase()
  await migrate()
  return db
}

async function historyDatabase() {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-pglite-"))
  cleanup.push(() => rm(dataDir, { force: true, recursive: true }))
  const definition = defineDatabase({ dialect: "postgresql", driver: "pglite", schema: workspaceHistorySchema })
  const db = await createDevPostgresDatabase(definition, { binding: "DB" }, { dataDir, migrationsDir: join(dataDir, "migrations") })
  const client: { exec: (sql: string) => Promise<unknown>, close: () => Promise<void> } = Reflect.get(db, "$client")
  cleanup.push(() => client.close())
  return {
    db,
    async migrate() {
      for (const statement of await historyMigration()) await client.exec(statement)
    },
  }
}

describe.skipIf(!url).each([
  { driver: "postgres.js", suffix: "js", createDatabase: createPostgresDatabase },
  { driver: "node-postgres", suffix: "pg", createDatabase: createNodePostgresDatabase },
])("Blob + Database Store on a Postgres server with $driver", ({ suffix, createDatabase }) => {
  const schema = `workspace_history_${process.pid}_${suffix}`
  const pools: Array<{ end: () => Promise<void> }> = []
  const connect = (searchPath = schema) => {
    const target = new URL(url!)
    target.searchParams.set("options", `-c search_path=${searchPath}`)
    vi.stubEnv("VITEHUB_TEST_WORKSPACE_DATABASE_URL", target.href)
    const definition = defineDatabase({ connection: { url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_WORKSPACE_DATABASE_URL" } } }, dialect: "postgresql", schema: {} })
    const db = createDatabase(definition, { binding: "DB" })
    pools.push(Reflect.get(db, "$client"))
    return db
  }

  afterAll(async () => {
    await connect("public").execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await Promise.all(pools.map(pool => pool.end()))
  })

  it("lets three instances on separate connections share one Workspace, and one of two commits from the same head wins", async () => {
    const control = connect("public")
    await control.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await control.execute(`CREATE SCHEMA ${schema}`)
    const migration = connect()
    for (const statement of await historyMigration()) await migration.execute(statement)

    const blob = await sharedBlob()
    const [a, b, c] = [connect(), connect(), connect()].map(database => createBlobDatabaseWorkspaceStore({ blob, database, workspace: "handbook" }))
    const base = await a!.history.commit({ ifHead: null, files: { "guide.md": { content: "base", path: "guide.md" } } })
    const fromB = await b!.history.commit({ ifHead: base.id, changes: { put: { "b.md": { content: "from b", path: "b.md" } } } })
    const fromC = await c!.history.commit({ ifHead: fromB.id, changes: { put: { "c.md": { content: "from c", path: "c.md" } } } })
    for (const store of [a!, b!, c!]) expect(await store.history.head()).toEqual(fromC)

    let head = fromC
    for (let round = 0; round < 5; round++) {
      const racers = [b!, c!]
      const results = await Promise.allSettled(racers.map((store, index) => store.history.commit({
        ifHead: head.id,
        changes: { put: { "race.md": { content: `round ${round} from ${index === 0 ? "b" : "c"}`, path: "race.md" } } },
      })))
      const won = results.flatMap(result => result.status === "fulfilled" ? [result.value] : [])
      const lost = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      expect(won).toHaveLength(1)
      expect(lost).toHaveLength(1)
      expect(lost[0]).toMatchObject({ code: "WORKSPACE_CONFLICT", details: { expected: head.id, actual: won[0]!.id } })
      head = won[0]!
      for (const store of [a!, b!, c!]) {
        expect(await store.history.head()).toEqual(head)
        expect(await text(store, head.id, "race.md")).toMatch(new RegExp(`^round ${round} from [bc]$`))
        expect(await text(store, head.id, "guide.md")).toBe("base")
      }
    }
    expect((await a!.history.list({ limit: 100 })).revisions).toHaveLength(8)
  })
})
