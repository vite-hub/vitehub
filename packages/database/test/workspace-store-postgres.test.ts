import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api-postgres"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createBlobStorage } from "../../blob/src/storage.ts"
import { createDriver } from "../../blob/src/drivers/fs.ts"
import { resolveWorkspaceStoreTarget } from "../../workspace/src/storage/target.ts"
import { createBlobDatabaseWorkspaceStore } from "../../workspace/src/blob-database.ts"
import { workspaceHistorySchema } from "../../workspace/src/blob-database/postgres.ts"
import { defineDatabase } from "../src/definition.ts"
import { createNodePostgresDatabase } from "../src/runtime/node-postgres.ts"
import { createDevPostgresDatabase } from "../src/runtime/pglite.ts"

import type { BlobStorage } from "@vite-hub/blob"
import type { BlobDatabaseWorkspaceStore } from "../../workspace/src/blob-database.ts"

const useDatabase = vi.fn()
vi.mock("@vite-hub/database/runtime/registry", () => ({ useDatabase }))

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

  it("applies the Postgres history schema and keeps history by Database name", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vitehub-workspace-pglite-"))
    cleanup.push(() => rm(dataDir, { force: true, recursive: true }))
    const definition = defineDatabase({ dialect: "postgresql", driver: "pglite", schema: workspaceHistorySchema })
    const db = await createDevPostgresDatabase(definition, { binding: "DB" }, { dataDir, migrationsDir: join(dataDir, "migrations") })
    const client: { exec: (sql: string) => Promise<unknown>, close: () => Promise<void> } = Reflect.get(db, "$client")
    cleanup.push(() => client.close())
    for (const statement of await historyMigration()) await client.exec(statement)
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
    await store.setMeta?.("owner", undefined)
    expect(await store.getMeta?.("owner")).toBeUndefined()

    await expect(store.history.deleteRef?.({ ref: "draft", ifHead: draft.id })).resolves.toBe(true)
    expect(await store.history.usage()).toEqual({ bytes: 11, objects: 3 })
    await store.delete()
    expect(await store.history.head()).toBeNull()
    expect(await store.history.usage()).toEqual({ bytes: 0, objects: 0 })
    await expect(store.history.commit({ ifHead: null, files: {} })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" })
  })
})

describe.skipIf(!url)("Blob + Database Store on a Postgres server", () => {
  const schema = `workspace_history_${process.pid}`
  const pools: Array<{ end: () => Promise<void> }> = []
  const connect = (searchPath = schema) => {
    const target = new URL(url!)
    target.searchParams.set("options", `-c search_path=${searchPath}`)
    vi.stubEnv("VITEHUB_TEST_WORKSPACE_DATABASE_URL", target.href)
    const definition = defineDatabase({ connection: { url: { kind: "env-variable", source: { kind: "env", name: "VITEHUB_TEST_WORKSPACE_DATABASE_URL" } } }, dialect: "postgresql", driver: "node-postgres", schema: {} })
    const db = createNodePostgresDatabase(definition, { binding: "DB" })
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
