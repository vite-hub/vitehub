import { databaseErrorDiagnostics } from "../error-diagnostics.ts"

// Cloudflare documents these limits at https://developers.cloudflare.com/d1/platform/limits/.
// D1 also limits the size of a row, which ViteHub cannot measure before SQLite writes it.
const d1Limits = {
  boundParameters: 100,
  statementBytes: 100_000,
  valueBytes: 2_000_000,
} as const

const encoder = /*#__PURE__*/ new TextEncoder()

/** Returns the UTF-8 size of `value` when it is above `limit`. */
function bytesAbove(value: string, limit: number): number | undefined {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so a short string cannot exceed the limit.
  if (value.length * 3 <= limit) return
  const bytes = encoder.encode(value).byteLength
  return bytes > limit ? bytes : undefined
}

function valueBytes(value: unknown): number | undefined {
  if (typeof value === "string") return bytesAbove(value, d1Limits.valueBytes)
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength > d1Limits.valueBytes ? value.byteLength : undefined
}

/** Throws the D1 error for a statement that Cloudflare D1 rejects. `params` are the bound values, by position or by name. */
export function assertD1Statement(sql: string, params: readonly unknown[] | Record<string, unknown> | undefined): void {
  const statementBytes = bytesAbove(sql, d1Limits.statementBytes)
  if (statementBytes !== undefined) throw databaseErrorDiagnostics.DATABASE_D1_STATEMENT_TOO_LONG({ bytes: statementBytes, limit: d1Limits.statementBytes })
  const values = Array.isArray(params) ? params : params ? Object.values(params) : []
  if (values.length > d1Limits.boundParameters) throw databaseErrorDiagnostics.DATABASE_D1_TOO_MANY_PARAMETERS({ count: values.length, limit: d1Limits.boundParameters })
  for (const value of values) {
    const bytes = valueBytes(value)
    if (bytes !== undefined) throw databaseErrorDiagnostics.DATABASE_D1_VALUE_TOO_LARGE({ bytes, limit: d1Limits.valueBytes })
  }
}

interface D1StatementLike {
  bind: (...params: unknown[]) => unknown
}

/** A D1 binding that checks each statement before the binding runs it. */
export function checkD1Limits<TDatabase extends object>(database: TDatabase): TDatabase {
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (property !== "prepare" || typeof value !== "function") return value
      return (query: string) => {
        assertD1Statement(query, undefined)
        const statement: D1StatementLike = Reflect.apply(value, target, [query])
        const bind = statement.bind
        Reflect.set(statement, "bind", (...params: unknown[]) => {
          assertD1Statement("", params)
          return Reflect.apply(bind, statement, params)
        })
        return statement
      }
    },
  })
}

type LibsqlStatement = string | { args?: readonly unknown[] | Record<string, unknown>, sql: string } | [string, (readonly unknown[] | Record<string, unknown>)?]

function assertLibsqlStatement(statement: LibsqlStatement, args?: readonly unknown[] | Record<string, unknown>): void {
  if (typeof statement === "string") return assertD1Statement(statement, args)
  if (Array.isArray(statement)) return assertD1Statement(statement[0], statement[1])
  assertD1Statement(statement.sql, statement.args)
}

/**
 * A libSQL client that rejects what Cloudflare D1 rejects. The dev server uses it when local SQLite stands in for a D1
 * binding, so a query that fails on D1 fails in development with the same code.
 */
export function checkLibsqlD1Limits<TClient extends object>(client: TClient): TClient {
  return new Proxy(client, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (typeof value !== "function") return value
      if (property === "execute") {
        return async (statement: LibsqlStatement, args?: readonly unknown[] | Record<string, unknown>) => {
          assertLibsqlStatement(statement, args)
          return Reflect.apply(value, target, args === undefined ? [statement] : [statement, args])
        }
      }
      if (property === "batch") {
        return async (statements: LibsqlStatement[], ...rest: unknown[]) => {
          for (const statement of statements) assertLibsqlStatement(statement)
          return Reflect.apply(value, target, [statements, ...rest])
        }
      }
      if (property === "transaction") return async (...args: unknown[]) => checkLibsqlD1Limits(Object(await Reflect.apply(value, target, args)))
      return value.bind(target)
    },
  })
}
