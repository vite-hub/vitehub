import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { Database, PreparedStatement, SqlValue } from "@sqlite.org/sqlite-wasm"

/**
 * A libSQL-compatible client on SQLite WASM, for runtimes that cannot load native SQLite, such as a StackBlitz WebContainer.
 *
 * Durability that this driver gives up, compared with native libSQL on a file:
 * - The database lives in memory. After each committed write, ViteHub writes the whole file to a temporary file and renames
 *   it over the database file. A crash cannot corrupt the file, but a process that stops during a write loses that write.
 * - There is no WAL and no file locking. Clients for the same file in one process share one database. Another process that
 *   writes the same file at the same time can lose writes. ViteHub reloads the file when it changes and no transaction is open.
 * - A transaction holds the database for its clients. Other clients wait for up to 5 seconds, then fail with `SQLITE_BUSY`.
 */

type Sqlite3 = Awaited<ReturnType<typeof import("@sqlite.org/sqlite-wasm").default>>
type IntMode = "bigint" | "number" | "string"
type TransactionMode = "deferred" | "read" | "write"
type InValue = ArrayBuffer | bigint | boolean | Date | null | number | string | Uint8Array | undefined
type InArgs = InValue[] | Record<string, InValue>
type InStatement = string | { args?: InArgs, sql: string }
type Row = Record<number | string, unknown> & { length: number }

export interface WasmSqliteResultSet {
  columns: string[]
  columnTypes: string[]
  lastInsertRowid: bigint | undefined
  rows: Row[]
  rowsAffected: number
  toJSON: () => unknown
}

export interface WasmSqliteTransaction {
  batch: (statements: InStatement[]) => Promise<WasmSqliteResultSet[]>
  close: () => void
  readonly closed: boolean
  commit: () => Promise<void>
  execute: (statement: InStatement) => Promise<WasmSqliteResultSet>
  executeMultiple: (sql: string) => Promise<void>
  rollback: () => Promise<void>
}

export interface WasmSqliteClient {
  batch: (statements: InStatement[], mode?: TransactionMode) => Promise<WasmSqliteResultSet[]>
  close: () => void
  readonly closed: boolean
  execute: ((statement: InStatement) => Promise<WasmSqliteResultSet>) & ((sql: string, args?: InArgs) => Promise<WasmSqliteResultSet>)
  executeMultiple: (sql: string) => Promise<void>
  migrate: (statements: InStatement[]) => Promise<WasmSqliteResultSet[]>
  readonly protocol: "file"
  reconnect: () => Promise<void>
  sync: () => Promise<undefined>
  transaction: (mode?: TransactionMode) => Promise<WasmSqliteTransaction>
}

export interface WasmSqliteClientOptions {
  intMode?: IntMode
  /** A `file:` URL, a path, or `:memory:`. */
  url: string
}

export interface WasmSqliteStatus {
  driver: "sqlite-wasm"
  /** What this driver gives up compared with native libSQL. */
  durability: string
  /** Absolute paths of the open database files. In-memory databases are not listed. */
  files: string[]
}

/**
 * Packages that a Nitro build in a WebContainer must trace instead of bundle, so their `.wasm` file is next to them in the
 * output: this driver's SQLite WASM, and the WASM build that a WebContainer installs for `@libsql/client`.
 */
export const wasmSqliteTraceDeps = ["@sqlite.org/sqlite-wasm", "@libsql/libsql-wasm-experimental"]

const durability = "Each database lives in memory. ViteHub writes the whole file after each committed write. There is no WAL and no lock with other processes, so a write from another process at the same time can be lost."
const busyTimeoutMs = 5_000

class WasmSqliteError extends Error {
  override readonly name = "LibsqlError"
  readonly code: string
  readonly rawCode: number | undefined

  constructor(message: string, code: string, rawCode?: number, cause?: unknown) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause })
    this.code = code
    this.rawCode = rawCode
  }
}

let sqlite3Promise: Promise<Sqlite3> | undefined
let warned = false

// A failed load lets the next open try again.
function loadSqlite3() {
  return sqlite3Promise ??= import("@sqlite.org/sqlite-wasm").then(module => module.default()).catch((error: unknown) => {
    sqlite3Promise = undefined
    throw error
  })
}

interface SharedDatabase {
  clients: number
  db: Database | undefined
  /** Last size and mtime that this process wrote or read, to notice writes from another process. */
  fileStamp: string | undefined
  lock: Promise<void>
  path: string | undefined
  ready: Promise<void> | undefined
}

const sharedDatabases = new Map<string, SharedDatabase>()

/** The SQLite WASM databases that this process has open, for inspection. */
export function wasmSqliteStatus(): WasmSqliteStatus {
  return {
    driver: "sqlite-wasm",
    durability,
    files: [...sharedDatabases.values()].flatMap(shared => shared.path ? [shared.path] : []),
  }
}

/** The absolute path of a local SQLite file URL or path. Remote URLs and in-memory databases have none. */
export function localSqliteFilePath(url: string): string | undefined {
  if (/^(?:libsql|https?|wss?):/i.test(url)) return
  let path = url
  if (/^file:\/\//i.test(url)) path = fileURLToPath(url.split(/[?#]/, 1)[0]!)
  else if (/^file:/i.test(url)) path = decodeURIComponent(url.slice(5).split(/[?#]/, 1)[0]!)
  if (!path || path === ":memory:" || /[?&]mode=memory(?:&|$)/.test(url)) return
  return resolve(path)
}

function stampOf(path: string): string | undefined {
  try {
    const stat = statSync(path)
    return `${stat.size}:${stat.mtimeMs}`
  }
  catch {
    return undefined
  }
}

function assertNoWal(path: string) {
  const stamp = stampOf(`${path}-wal`)
  if (stamp && !stamp.startsWith("0:")) {
    throw new WasmSqliteError(`Cannot open ${path} with SQLite WASM while its WAL file contains data. Checkpoint the WAL and close the native SQLite connections before retrying.`, "SQLITE_BUSY", 5)
  }
}

function toError(error: unknown, sqlite3: Sqlite3 | undefined): WasmSqliteError {
  if (error instanceof WasmSqliteError) return error
  const message = error instanceof Error ? error.message : String(error)
  const resultCode = typeof error === "object" && error !== null && "resultCode" in error && typeof error.resultCode === "number" ? error.resultCode : undefined
  const code = resultCode !== undefined && sqlite3 ? sqlite3.capi.sqlite3_js_rc_str(resultCode) || "SQLITE_ERROR" : "SQLITE_ERROR"
  return new WasmSqliteError(message.replace(/^SQLITE_[A-Z_]+:\s*(?:sqlite3 result code \d+:\s*)?/, ""), code, resultCode, error)
}

function openDatabase(sqlite3: Sqlite3, path: string | undefined): { db: Database, stamp: string | undefined } {
  if (path) assertNoWal(path)
  const db = new sqlite3.oo1.DB(":memory:", "c")
  db.exec("PRAGMA foreign_keys = ON")
  if (!path) return { db, stamp: undefined }
  mkdirSync(dirname(path), { recursive: true })
  const stamp = stampOf(path)
  if (!stamp || stamp.startsWith("0:")) return { db, stamp }
  const bytes = new Uint8Array(readFileSync(path))
  // With no pending WAL, a WAL-mode main file is safe to read as a rollback-journal file in memory.
  if (bytes.length >= 20 && bytes[18] === 2 && bytes[19] === 2) {
    bytes[18] = 1
    bytes[19] = 1
  }
  // sqlite3_deserialize recommends at least 20 zero bytes of padding for malformed input.
  const buffer = new Uint8Array(bytes.length + 20)
  buffer.set(bytes)
  const pointer = sqlite3.wasm.allocFromTypedArray(buffer)
  const flags = sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
  const rc = sqlite3.capi.sqlite3_deserialize(db.pointer!, "main", pointer, bytes.length, buffer.length, flags)
  if (rc !== 0) {
    db.close()
    throw new WasmSqliteError(`Could not read the SQLite file ${path}.`, sqlite3.capi.sqlite3_js_rc_str(rc) || "SQLITE_ERROR", rc)
  }
  return { db, stamp }
}

function valueToSql(value: InValue, intMode: IntMode): SqlValue {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Only finite numbers (not Infinity or NaN) can be passed as arguments")
    return value
  }
  if (typeof value === "boolean") return intMode === "bigint" ? (value ? 1n : 0n) : intMode === "string" ? (value ? "1" : "0") : (value ? 1 : 0)
  if (value instanceof Date) return value.valueOf()
  if (value === undefined) throw new TypeError("undefined cannot be passed as argument to the database")
  return value
}

function valueFromSql(value: unknown, intMode: IntMode): unknown {
  if (typeof value === "bigint") {
    if (intMode === "bigint") return value
    if (intMode === "string") return `${value}`
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("Received integer which cannot be safely represented as a JavaScript number")
    }
    return Number(value)
  }
  // Native libSQL returns blobs as ArrayBuffer.
  if (value instanceof Uint8Array) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  return value
}

function rowFromSql(values: unknown[], columns: string[], intMode: IntMode): Row {
  const row = {} as Row
  Object.defineProperty(row, "length", { value: values.length })
  values.forEach((raw, index) => {
    const value = valueFromSql(raw, intMode)
    Object.defineProperty(row, index, { value })
    const column = columns[index]!
    if (!Object.hasOwn(row, column)) Object.defineProperty(row, column, { configurable: true, enumerable: true, value, writable: true })
  })
  return row
}

function resultSet(columns: string[], columnTypes: string[], rows: Row[], rowsAffected: number, lastInsertRowid: bigint | undefined): WasmSqliteResultSet {
  return {
    columns,
    columnTypes,
    lastInsertRowid,
    rows,
    rowsAffected,
    toJSON: () => ({
      columns,
      columnTypes,
      lastInsertRowid: lastInsertRowid === undefined ? null : `${lastInsertRowid}`,
      rows: rows.map(row => Array.from(row as ArrayLike<unknown>, value => typeof value === "bigint" ? `${value}` : value)),
      rowsAffected,
    }),
  }
}

function bindArgs(sqlite3: Sqlite3, statement: PreparedStatement, args: InArgs | undefined, intMode: IntMode) {
  if (!args) return
  if (Array.isArray(args)) {
    args.forEach((value, index) => statement.bind(index + 1, valueToSql(value, intMode)))
    return
  }
  for (const [name, value] of Object.entries(args)) {
    const names = /^[:@$]/.test(name) ? [name] : [`:${name}`, `@${name}`, `$${name}`]
    const index = names.map(candidate => sqlite3.capi.sqlite3_bind_parameter_index(statement.pointer!, candidate)).find(found => found > 0)
    if (index !== undefined) statement.bind(index, valueToSql(value, intMode))
  }
}

function beginStatement(mode: TransactionMode) {
  // SQLite has no read-only BEGIN; libSQL's `BEGIN TRANSACTION READONLY` is an extension.
  return mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED"
}

/**
 * Opens a libSQL-compatible client on SQLite WASM. See the module comment for what it gives up. It logs that once per process.
 */
export function createWasmSqliteClient(options: WasmSqliteClientOptions): WasmSqliteClient {
  const intMode = options.intMode ?? "number"
  let path = localSqliteFilePath(options.url)
  if (path) {
    // Resolve aliases before sharing the database or atomically replacing its file.
    mkdirSync(dirname(path), { recursive: true })
    try {
      path = realpathSync(path)
    }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      path = resolve(realpathSync(dirname(path)), basename(path))
    }
  }
  let shared = path ? sharedDatabases.get(path) : undefined
  if (!shared) {
    shared = { clients: 0, db: undefined, fileStamp: undefined, lock: Promise.resolve(), path, ready: undefined }
    if (path) sharedDatabases.set(path, shared)
  }
  const database = shared
  database.clients++
  let closed = false
  let sqlite3: Sqlite3 | undefined

  if (path && !warned) {
    warned = true
    console.warn(`[vitehub] This runtime cannot load native SQLite, so ViteHub opens local SQLite files with SQLite WASM. ${durability} First file: ${path}`)
  }

  async function ready(): Promise<Sqlite3> {
    sqlite3 = await loadSqlite3()
    const loaded = sqlite3
    database.ready ??= Promise.resolve().then(() => {
      const opened = openDatabase(loaded, path)
      database.db = opened.db
      database.fileStamp = opened.stamp
    }).catch((error) => {
      database.ready = undefined
      throw error
    })
    await database.ready
    return loaded
  }

  function db(): Database {
    if (!database.db) throw new WasmSqliteError("The database is closed", "CLIENT_CLOSED")
    return database.db
  }

  function inTransaction() {
    return sqlite3!.capi.sqlite3_get_autocommit(db().pointer!) === 0
  }

  // Another process may have written the file. Read it again before the next statement outside a transaction.
  function reloadIfChanged(loaded: Sqlite3) {
    if (!path || inTransaction()) return
    // WAL commits may not change the main file's stamp.
    assertNoWal(path)
    const stamp = stampOf(path)
    if (stamp === database.fileStamp || stamp === undefined) return
    const opened = openDatabase(loaded, path)
    database.db?.close()
    database.db = opened.db
    database.fileStamp = opened.stamp
  }

  function flush() {
    if (!path || inTransaction()) return
    assertNoWal(path)
    const bytes = sqlite3!.capi.sqlite3_js_db_export(db())
    const temporary = `${path}.${process.pid}.tmp`
    writeFileSync(temporary, bytes)
    renameSync(temporary, path)
    database.fileStamp = stampOf(path)
  }

  function run(statement: InStatement): { result: WasmSqliteResultSet, wrote: boolean } {
    const sql = typeof statement === "string" ? statement : statement.sql
    const args = typeof statement === "string" ? undefined : statement.args
    let prepared: PreparedStatement | undefined
    try {
      prepared = db().prepare(sql)
      bindArgs(sqlite3!, prepared, args, intMode)
      const wrote = sqlite3!.capi.sqlite3_stmt_readonly(prepared.pointer!) === 0
      if (prepared.columnCount > 0) {
        const columns = prepared.getColumnNames()
        const columnTypes = columns.map((_, index) => sqlite3!.capi.sqlite3_column_decltype(prepared!.pointer!, index) ?? "")
        const rows: Row[] = []
        while (prepared.step()) rows.push(rowFromSql(prepared.get([]), columns, intMode))
        const rowsAffected = wrote ? sqlite3!.capi.sqlite3_changes(db().pointer!) : 0
        return { result: resultSet(columns, columnTypes, rows, rowsAffected, undefined), wrote }
      }
      prepared.step()
      const changes = db().changes()
      return { result: resultSet([], [], [], Number(changes), BigInt(sqlite3!.capi.sqlite3_last_insert_rowid(db().pointer!))), wrote }
    }
    catch (error) {
      throw toError(error, sqlite3)
    }
    finally {
      prepared?.finalize()
    }
  }

  // One holder at a time per database: a transaction keeps it until it ends. Like a busy timeout, waiting fails after 5 seconds.
  async function acquire(): Promise<() => void> {
    const previous = database.lock
    let release!: () => void
    database.lock = new Promise<void>(resolve => { release = resolve })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WasmSqliteError("database is locked", "SQLITE_BUSY", 5)), busyTimeoutMs)
    })
    try {
      await Promise.race([previous, timeout])
    }
    catch (error) {
      // Keep the queue order: the next holder waits for the one before this caller.
      void previous.then(release)
      throw error
    }
    finally {
      clearTimeout(timer)
    }
    return release
  }

  async function exclusive<T>(work: () => T): Promise<T> {
    if (closed) throw new WasmSqliteError("The client is closed", "CLIENT_CLOSED")
    const release = await acquire()
    try {
      const loaded = await ready()
      reloadIfChanged(loaded)
      return work()
    }
    finally {
      release()
    }
  }

  function runBatch(statements: InStatement[], begin: string): WasmSqliteResultSet[] {
    run(begin)
    try {
      const results = statements.map((statement) => {
        if (!inTransaction()) throw new WasmSqliteError("The transaction has been rolled back", "TRANSACTION_CLOSED")
        return run(statement).result
      })
      run("COMMIT")
      return results
    }
    finally {
      if (inTransaction()) run("ROLLBACK")
      flush()
    }
  }

  const client: WasmSqliteClient = {
    get closed() {
      return closed
    },
    protocol: "file",
    execute: (async (statement: InStatement, args?: InArgs) => await exclusive(() => {
      const { result, wrote } = run(typeof statement === "string" ? { args, sql: statement } : statement)
      if (wrote) flush()
      return result
    })) as WasmSqliteClient["execute"],
    batch: async (statements, mode = "deferred") => await exclusive(() => runBatch(statements, beginStatement(mode))),
    migrate: async statements => await exclusive(() => {
      run("PRAGMA foreign_keys=off")
      try {
        return runBatch(statements, "BEGIN DEFERRED")
      }
      finally {
        run("PRAGMA foreign_keys=on")
      }
    }),
    executeMultiple: async sql => await exclusive(() => {
      try {
        db().exec(sql)
      }
      catch (error) {
        throw toError(error, sqlite3)
      }
      finally {
        if (inTransaction()) run("ROLLBACK")
        flush()
      }
    }),
    async transaction(mode = "write") {
      if (closed) throw new WasmSqliteError("The client is closed", "CLIENT_CLOSED")
      const release = await acquire()
      let done = false
      const end = () => {
        if (done) return
        done = true
        try {
          if (database.db && inTransaction()) run("ROLLBACK")
          if (database.db) flush()
        }
        finally {
          release()
        }
      }
      try {
        const loaded = await ready()
        reloadIfChanged(loaded)
        run(beginStatement(mode))
      }
      catch (error) {
        end()
        throw error
      }
      const step = <T>(work: () => T): Promise<T> => {
        if (done) return Promise.reject(new WasmSqliteError("The transaction is closed", "TRANSACTION_CLOSED"))
        return Promise.resolve().then(work)
      }
      return {
        get closed() {
          return done
        },
        execute: async statement => await step(() => run(statement).result),
        batch: async statements => await step(() => statements.map(statement => run(statement).result)),
        executeMultiple: async sql => await step(() => {
          try {
            db().exec(sql)
          }
          catch (error) {
            throw toError(error, sqlite3)
          }
        }),
        commit: async () => await step(() => {
          run("COMMIT")
          end()
        }),
        rollback: async () => {
          if (!done) end()
        },
        close: () => end(),
      }
    },
    async sync() {
      return undefined
    },
    async reconnect() {
      await exclusive(() => {})
    },
    close() {
      if (closed) return
      closed = true
      database.clients--
      if (database.clients > 0) return
      // Keep the entry available to reopened clients until all admitted work has finished.
      const lock = database.lock
      void lock.then(() => {
        if (database.clients > 0 || database.lock !== lock) return
        database.db?.close()
        database.db = undefined
        if (path && sharedDatabases.get(path) === database) sharedDatabases.delete(path)
      })
    },
  }
  return client
}
