import sqlite3InitModule from "@sqlite.org/sqlite-wasm"
import type { BindingSpec, Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm"
import sqliteWasmModule from "@sqlite.org/sqlite-wasm/sqlite3.wasm?module"
import type { ContentFile, RelationalDatabase } from "comark-content"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

type Row = Record<string, unknown>

interface SqliteWasmModuleArg {
  instantiateWasm: (imports: object, done: (instance: object, module: object) => void) => object
}

interface WasmNamespace {
  instantiate: (module: object, imports: object) => Promise<object>
}

// The repository's TypeScript config has no DOM lib, which types `WebAssembly`.
const wasm: WasmNamespace = Object.getOwnPropertyDescriptor(globalThis, "WebAssembly")?.value

// SAFETY: the published type of `sqlite3InitModule()` omits the Emscripten module argument that the function accepts.
const initSqlite = sqlite3InitModule as unknown as (moduleArg: SqliteWasmModuleArg) => Promise<Sqlite3Static>

// workerd compiles WebAssembly only while the Worker starts, and SQLite WASM compiles small modules for its callbacks
// while it starts. So this module starts SQLite at load time, and ViteHub imports it from a Nitro plugin when
// `server/content.ts` imports `vite-hub/content/sqlite`. Nitro gives a compiled module, or a Promise of one with
// `wasm.lazy`.
const loaded = await initSqlite({
  instantiateWasm(imports, done) {
    void Promise.resolve(sqliteWasmModule).then(async (module) => {
      done(await wasm.instantiate(module, imports), module)
    })
    return {}
  },
}).then(sqlite3 => ({ sqlite3 }), (error: unknown) => ({ error }))

function loadedSqlite(): Sqlite3Static {
  if ("sqlite3" in loaded) return loaded.sqlite3
  throw contentErrorDiagnostics.CONTENT_R0018({
    cause: loaded.error,
    message: `[vitehub] SQLite WASM could not start: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`,
  })
}

const parse = (value: unknown): unknown => value == null ? undefined : JSON.parse(String(value))
const stringify = (value: unknown): string | null => value == null ? null : JSON.stringify(value)
const record = (value: unknown): Record<string, unknown> => Object(value) === value ? value as Record<string, unknown> : {}

// The same table and statements as Comark's SQLite adapters, so index plugins see the same rows on every host.
const contentsTable = "CREATE TABLE IF NOT EXISTS __contents (key TEXT PRIMARY KEY, source TEXT NOT NULL, path TEXT, stem TEXT, extension TEXT, kind TEXT, type TEXT, data TEXT, meta TEXT, nodes TEXT, partial BOOLEAN)"
const sourceIndex = "CREATE INDEX IF NOT EXISTS __contents_source_idx ON __contents (source)"
const upsertContent = "INSERT INTO __contents (key, source, path, stem, extension, kind, type, data, meta, nodes, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET source = excluded.source, path = excluded.path, stem = excluded.stem, extension = excluded.extension, kind = excluded.kind, type = excluded.type, data = excluded.data, meta = excluded.meta, nodes = excluded.nodes, partial = excluded.partial"

// Comark's adapters also return `source` on the file.
function rowToFile(row: Row): ContentFile & { source: string } {
  const text = (value: unknown): string => value == null ? "" : String(value)
  return {
    source: text(row.source),
    path: text(row.path),
    // SAFETY: `upsert()` wrote these columns with `JSON.stringify()` of the same ContentFile fields.
    data: (parse(row.data) || {}) as ContentFile["data"],
    nodes: (parse(row.nodes) || []) as ContentFile["nodes"],
    meta: {
      ...record(parse(row.meta)),
      key: text(row.key),
      source: text(row.source),
      stem: text(row.stem),
      extension: text(row.extension),
      kind: row.kind === "media" ? "media" : "document",
      type: text(row.type),
      partial: !!row.partial,
    },
  }
}

/**
 * An in-memory SQLite database on SQLite WASM, for Cloudflare Workers. Node SQLite is a stub there.
 */
export function sqlite(): RelationalDatabase {
  let database: Database | undefined
  const db = (): Database => {
    if (database) return database
    database = new (loadedSqlite().oo1.DB)(":memory:", "c")
    database.exec(contentsTable)
    database.exec(sourceIndex)
    return database
  }
  const rows = (sql: string, params: readonly unknown[] = []): Row[] =>
    db().exec({ sql, bind: params as BindingSpec, rowMode: "object", returnValue: "resultRows" })
  return {
    async first<T>(sql: string, params?: unknown[]) {
      return rows(sql, params)[0] as T | undefined
    },
    async all<T>(sql: string, params?: unknown[]) {
      return rows(sql, params) as T[]
    },
    async execute<T>(sql: string, params?: unknown[]) {
      if (params?.length) db().exec({ sql, bind: params as BindingSpec })
      else db().exec(sql)
      return undefined as T
    },
    async upsert(source, file) {
      const { key, source: _source, stem, extension, kind, type, partial, ...meta } = record(file.meta)
      db().exec({
        sql: upsertContent,
        bind: [key, source, file.path ?? null, stem ?? null, extension ?? null, kind ?? null, type ?? null, stringify(file.data), stringify(meta), stringify(file.nodes), partial ? 1 : 0] as BindingSpec,
      })
    },
    async get(_source, key) {
      const [row] = rows("SELECT * FROM __contents WHERE key = ?", [key])
      return (row ? rowToFile(row) : undefined) as ContentFile
    },
    async delete(_source, key) {
      db().exec({ sql: "DELETE FROM __contents WHERE key = ?", bind: [key] })
    },
    async list(source) {
      return rows("SELECT * FROM __contents WHERE source = ?", [source]).map(rowToFile)
    },
    async clear(source) {
      db().exec({ sql: "DELETE FROM __contents WHERE source = ?", bind: [source] })
    },
  }
}
