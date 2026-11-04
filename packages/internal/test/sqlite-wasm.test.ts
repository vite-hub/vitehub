import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
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

  it.each(["new", "existing", "reloaded"])("enforces foreign keys for %s databases without running migrations", async (state) => {
    const path = join(dir, "foreign-keys.sqlite")
    const schema = `
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) ON DELETE CASCADE);
      INSERT INTO parents VALUES (1);
      INSERT INTO children VALUES (1, 1);
    `
    const client = createWasmSqliteClient({ url: `file:${path}` })
    try {
      if (state === "new") {
        await client.executeMultiple(schema)
      }
      else {
        if (state === "reloaded") await client.execute("SELECT 1")
        const native = new DatabaseSync(path)
        try {
          native.exec(schema)
        }
        finally {
          native.close()
        }
      }

      await expect(client.execute("INSERT INTO children VALUES (2, 999)")).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" })
      await client.execute("DELETE FROM parents WHERE id = 1")
      expect((await client.execute("SELECT id FROM children")).rows).toEqual([])
    }
    finally {
      client.close()
    }
  })

  it("preserves a database symlink and shares its target between clients", async () => {
    const path = join(dir, "target.sqlite")
    const link = join(dir, "linked.sqlite")
    const native = new DatabaseSync(path)
    native.exec("CREATE TABLE t (n INTEGER)")
    native.close()
    await symlink("target.sqlite", link)

    const linked = createWasmSqliteClient({ url: `file:${link}` })
    const direct = createWasmSqliteClient({ url: `file:${path}` })
    let transaction
    try {
      await linked.execute("INSERT INTO t VALUES (1)")
      expect((await lstat(link)).isSymbolicLink()).toBe(true)
      const reader = new DatabaseSync(path)
      try {
        expect(reader.prepare("SELECT n FROM t").all()).toEqual([{ n: 1 }])
      }
      finally {
        reader.close()
      }

      transaction = await linked.transaction("write")
      await transaction.execute("INSERT INTO t VALUES (2)")
      const inserted = direct.execute("INSERT INTO t VALUES (3)")
      try {
        await transaction.commit()
      }
      finally {
        await inserted
      }
      expect((await direct.execute("SELECT n FROM t ORDER BY n")).rows.map(row => row.n)).toEqual([1, 2, 3])
      expect(wasmSqliteStatus().files).toEqual([path])
    }
    finally {
      transaction?.close()
      linked.close()
      direct.close()
    }
  })

  it("keeps one database when the last client closes during a transaction and another opens", async () => {
    const path = join(dir, "reopen.sqlite")
    const url = `file:${path}`
    const client = createWasmSqliteClient({ url })
    await client.execute("CREATE TABLE t (n INTEGER)")
    const transaction = await client.transaction("write")
    await transaction.execute("INSERT INTO t VALUES (1)")
    client.close()

    const reopened = createWasmSqliteClient({ url })
    const inserted = reopened.execute("INSERT INTO t VALUES (2)")
    // Let the reopened client reach the old transaction's lock before committing.
    await new Promise<void>(resolve => setImmediate(resolve))
    try {
      await transaction.commit()
      await inserted
      expect((await reopened.execute("SELECT n FROM t ORDER BY n")).rows.map(row => row.n)).toEqual([1, 2])
      const native = new DatabaseSync(path)
      try {
        expect(native.prepare("SELECT n FROM t ORDER BY n").all()).toEqual([{ n: 1 }, { n: 2 }])
      }
      finally {
        native.close()
      }
    }
    finally {
      transaction.close()
      reopened.close()
    }
  })

  it("finishes queued work when a client closes before initialization", async () => {
    const url = `file:${join(dir, "initializing.sqlite")}`
    const client = createWasmSqliteClient({ url })
    const created = client.execute("CREATE TABLE t (n INTEGER)")
    client.close()
    const reopened = createWasmSqliteClient({ url })
    try {
      await created
      await reopened.execute("INSERT INTO t VALUES (1)")
      expect((await reopened.execute("SELECT n FROM t")).rows.map(row => row.n)).toEqual([1])
    }
    finally {
      reopened.close()
    }
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

  it("rejects a file with uncheckpointed WAL commits without replacing it", async () => {
    const path = join(dir, "wal.sqlite")
    const native = new DatabaseSync(path)
    native.exec("CREATE TABLE t (n INTEGER); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO t VALUES (7)")
    const original = await readFile(path)
    const wal = await readFile(`${path}-wal`)
    const client = createWasmSqliteClient({ url: `file:${path}` })
    try {
      await expect(client.execute("SELECT n FROM t")).rejects.toMatchObject({ code: "SQLITE_BUSY" })
      await expect(client.execute("INSERT INTO t VALUES (8)")).rejects.toMatchObject({ code: "SQLITE_BUSY" })
      expect(await readFile(path)).toEqual(original)
      expect(await readFile(`${path}-wal`)).toEqual(wal)
      expect(native.prepare("SELECT n FROM t").all()).toEqual([{ n: 7 }])
    }
    finally {
      client.close()
      native.close()
    }

    // Closing the native connection checkpoints its WAL, so the file is safe to import again.
    const reopened = createWasmSqliteClient({ url: `file:${path}` })
    try {
      expect((await reopened.execute("SELECT n FROM t")).rows.map(row => row.n)).toEqual([7])
    }
    finally {
      reopened.close()
    }
  })

  it("rejects WAL commits made after a client opened, even if the main file did not change", async () => {
    const path = join(dir, "external-wal.sqlite")
    const client = createWasmSqliteClient({ url: `file:${path}` })
    await client.execute("CREATE TABLE t (n INTEGER)")
    const native = new DatabaseSync(path)
    try {
      native.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
      // Import the WAL-mode main file before any WAL frames exist.
      await client.execute("SELECT n FROM t")
      const original = await readFile(path)
      native.exec("INSERT INTO t VALUES (7)")
      expect(await readFile(path)).toEqual(original)
      await expect(client.execute("SELECT n FROM t")).rejects.toMatchObject({ code: "SQLITE_BUSY" })
      await expect(client.execute("INSERT INTO t VALUES (8)")).rejects.toMatchObject({ code: "SQLITE_BUSY" })
      expect(await readFile(path)).toEqual(original)
    }
    finally {
      native.close()
    }
    try {
      expect((await client.execute("SELECT n FROM t")).rows.map(row => row.n)).toEqual([7])
    }
    finally {
      client.close()
    }
  })

  it("rejects a file that is not SQLite", async () => {
    const path = join(dir, "broken.sqlite")
    await writeFile(path, "not a database, but long enough to have a header field")
    const client = createWasmSqliteClient({ url: `file:${path}` })
    await expect(client.execute("SELECT 1")).rejects.toMatchObject({ name: "LibsqlError" })
    client.close()
    expect(await readFile(path, "utf8")).toContain("not a database")
  })

  it("rejects a truncated SQLite file without replacing the malformed input", async () => {
    const path = join(dir, "truncated.sqlite")
    const native = new DatabaseSync(path)
    native.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1)")
    native.close()
    const truncated = (await readFile(path)).subarray(0, 100)
    await writeFile(path, truncated)
    const client = createWasmSqliteClient({ url: `file:${path}` })
    try {
      await expect(client.execute("SELECT n FROM t")).rejects.toMatchObject({ name: "LibsqlError" })
      expect(await readFile(path)).toEqual(truncated)
    }
    finally {
      client.close()
    }
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
