import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWasmSqliteClient, localSqliteFilePath, wasmSqliteStatus } from "../src/runtime/sqlite-wasm.ts"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vitehub-sqlite-wasm-"))
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { force: true, recursive: true })
})

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 10))
}

describe("createWasmSqliteClient", () => {
  it("writes a real SQLite file after each committed write and reads it again", async () => {
    const path = join(dir, "data", "app.sqlite")
    const client = createWasmSqliteClient({ url: `file:${path}` })
    await client.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body BLOB)")
    const inserted = await client.execute({ sql: "INSERT INTO notes (title, body) VALUES (?, ?)", args: ["first", new Uint8Array([1, 2])] })
    expect(inserted.rowsAffected).toBe(1)
    expect(inserted.lastInsertRowid).toBe(1n)
    client.close()
    await settle()

    // Native SQLite opens the file that SQLite WASM wrote.
    const native = new DatabaseSync(path)
    expect(native.prepare("SELECT title FROM notes").all()).toEqual([{ title: "first" }])
    native.close()

    const reopened = createWasmSqliteClient({ url: `file:${path}` })
    const result = await reopened.execute({ sql: "SELECT id, title, body FROM notes WHERE title = :title", args: { title: "first" } })
    expect(result.columns).toEqual(["id", "title", "body"])
    expect(result.rows[0]).toMatchObject({ id: 1, title: "first" })
    expect(new Uint8Array(result.rows[0]!.body as ArrayBuffer)).toEqual(new Uint8Array([1, 2]))
    expect(Array.from(result.rows[0] as ArrayLike<unknown>).slice(0, 2)).toEqual([1, "first"])
    expect(wasmSqliteStatus()).toMatchObject({ driver: "sqlite-wasm", files: [path] })
    reopened.close()
  })

  it("shares one database between clients of the same file", async () => {
    const url = `file:${join(dir, "shared.sqlite")}`
    const first = createWasmSqliteClient({ url })
    const second = createWasmSqliteClient({ url })
    await first.execute("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)")
    await second.execute({ sql: "INSERT INTO kv VALUES (?, ?)", args: ["a", "1"] })
    expect((await first.execute("SELECT v FROM kv")).rows.map(row => row.v)).toEqual(["1"])
    first.close()
    second.close()
  })

  it("commits and rolls back transactions and batches", async () => {
    const path = join(dir, "tx.sqlite")
    const client = createWasmSqliteClient({ url: `file:${path}` })
    await client.execute("CREATE TABLE items (name TEXT UNIQUE)")

    const committed = await client.transaction("write")
    await committed.execute({ sql: "INSERT INTO items VALUES (?)", args: ["kept"] })
    await committed.commit()

    const rolledBack = await client.transaction("write")
    await rolledBack.execute({ sql: "INSERT INTO items VALUES (?)", args: ["dropped"] })
    await rolledBack.rollback()

    await expect(client.batch([
      { sql: "INSERT INTO items VALUES (?)", args: ["batch"] },
      { sql: "INSERT INTO items VALUES (?)", args: ["kept"] },
    ], "write")).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_UNIQUE" })

    expect((await client.execute("SELECT name FROM items")).rows.map(row => row.name)).toEqual(["kept"])
    client.close()
    await settle()
    const native = new DatabaseSync(path)
    expect(native.prepare("SELECT name FROM items").all()).toEqual([{ name: "kept" }])
    native.close()
  })

  it("lets other clients wait for an open transaction", async () => {
    const url = `file:${join(dir, "wait.sqlite")}`
    const client = createWasmSqliteClient({ url })
    await client.execute("CREATE TABLE t (n INTEGER)")
    const transaction = await client.transaction("write")
    const waiting = client.execute("SELECT count(*) AS n FROM t")
    await transaction.execute("INSERT INTO t VALUES (1)")
    await transaction.commit()
    expect((await waiting).rows[0]!.n).toBe(1)
    client.close()
  })

  it("reads a file that another process changed", async () => {
    const path = join(dir, "external.sqlite")
    const client = createWasmSqliteClient({ url: `file:${path}` })
    await client.execute("CREATE TABLE t (n INTEGER)")
    await new Promise(resolve => setTimeout(resolve, 20))
    const native = new DatabaseSync(path)
    native.exec("INSERT INTO t VALUES (7)")
    native.close()
    expect((await client.execute("SELECT n FROM t")).rows.map(row => row.n)).toEqual([7])
    client.close()
  })

  it("rejects a file that is not SQLite", async () => {
    const path = join(dir, "broken.sqlite")
    await writeFile(path, "not a database, but long enough to have a header field")
    const client = createWasmSqliteClient({ url: `file:${path}` })
    await expect(client.execute("SELECT 1")).rejects.toMatchObject({ name: "LibsqlError" })
    client.close()
    expect(await readFile(path, "utf8")).toContain("not a database")
  })
})

describe("localSqliteFilePath", () => {
  it("returns a path only for local files", () => {
    expect(localSqliteFilePath("file:.vitehub/data/app.sqlite")).toBe(join(process.cwd(), ".vitehub/data/app.sqlite"))
    expect(localSqliteFilePath("file:///tmp/a.sqlite")).toBe("/tmp/a.sqlite")
    expect(localSqliteFilePath(":memory:")).toBeUndefined()
    expect(localSqliteFilePath("file::memory:?cache=shared")).toBeUndefined()
    expect(localSqliteFilePath("libsql://db.turso.io")).toBeUndefined()
    expect(localSqliteFilePath("https://db.turso.io")).toBeUndefined()
  })
})
