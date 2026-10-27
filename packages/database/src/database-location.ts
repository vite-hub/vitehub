import { databaseErrorDiagnostics } from "./error-diagnostics.ts"

/** Where a database is, as `connectDatabase()` reads it: a D1 binding, an environment variable, a URL, or a file. */
export type DatabaseLocation =
  | { kind: "auto" }
  | { kind: "d1", binding: string }
  | { kind: "env", name: string }
  | { kind: "url", url: string }
  | { kind: "file", path: string }

const remoteSchemes = /^(?:libsql|https?):\/\//i
export const postgresSchemes = /^postgres(?:ql)?:\/\//i

/**
 * Reads a database location:
 *
 * - `d1:COMMENTS`: the Cloudflare D1 binding `COMMENTS`.
 * - `env:DATABASE_URL`: the URL in that environment variable, read at runtime.
 * - `libsql://…`, `https://…`: a libSQL URL, such as Turso's. A token in it ends up in the build; prefer `env:`.
 * - `file:./data/app.sqlite`, or `:memory:`: a SQLite file, on Node.
 * - Nothing: `DATABASE_URL`, else `TURSO_DATABASE_URL`, else the D1 binding `DB`.
 *
 * Set `node: false` to reject static files for a runtime without Node file support.
 */
export function parseDatabaseLocation(where: string | undefined, name = "default", options: { node?: boolean } = {}): DatabaseLocation {
  if (where === undefined || where === "") return { kind: "auto" }
  if (where.startsWith("d1:") && where.length > 3) return { kind: "d1", binding: where.slice(3) }
  if (where.startsWith("env:") && where.length > 4) return { kind: "env", name: where.slice(4) }
  if (where.startsWith("file:") || where === ":memory:") {
    if (options.node === false) throw databaseErrorDiagnostics.DATABASE_UNSUPPORTED_URL({ database: name, value: "a SQLite file on this runtime" })
    return { kind: "file", path: where.startsWith("file:") ? where.slice(5) : where }
  }
  if (remoteSchemes.test(where)) return { kind: "url", url: where }
  throw databaseErrorDiagnostics.DATABASE_UNSUPPORTED_URL({ database: name, value: postgresSchemes.test(where) ? "a Postgres URL" : JSON.stringify(where) })
}
