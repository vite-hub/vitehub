import { and, eq, isNull, or, sql } from "drizzle-orm"

import { canonical, jsonReplacer, sameValue, toJson } from "./canonical.ts"
import { syncErrors } from "./errors.ts"

import type { SQL } from "drizzle-orm"
import type { SQLiteColumn } from "drizzle-orm/sqlite-core"
import type { SyncTable } from "./define.ts"
import type { SyncValues } from "./protocol.ts"

export function column(table: SyncTable, name: string): SQLiteColumn {
  // SAFETY: callers pass only names that they checked against `table.columns`.
  return table.columns[name]!
}

/** A JSON value of a column as Drizzle wants it: a `Date` for a timestamp column, a `bigint` for a bigint column. */
export function decode(table: SyncTable, name: string, value: unknown): unknown {
  if (value === null || value === undefined) return value
  const { dataType } = column(table, name)
  if (dataType.startsWith("object date") && (typeof value === "string" || typeof value === "number")) return new Date(value)
  if (dataType.startsWith("bigint") && (typeof value === "string" || typeof value === "number")) return BigInt(value)
  return value
}

/**
 * The values that `where` returned, as JSON. Each name must be a column. A list is sorted and has no repeats, so the
 * scope id does not depend on the order in which the app read the teams of the caller.
 */
export function readWhere(syncName: string, table: SyncTable, where: object): SyncValues {
  const values: SyncValues = {}
  for (const [name, value] of Object.entries(where)) {
    if (value === undefined) continue
    if (!(name in table.columns)) {
      throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] server/sync/${syncName}: \`where\` returned \`${name}\`, which is not a column of the table "${table.name}".` })
    }
    if (Array.isArray(value)) {
      const unique = new Map<string, unknown>()
      for (const item of value) unique.set(canonical(item), toJson(item) ?? null)
      values[name] = [...unique.keys()].sort().map(text => unique.get(text))
    }
    else {
      values[name] = toJson(value) ?? null
    }
  }
  return values
}

function isSingle(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

/** Reads the subset of a pull or a push: single JSON values on columns. Returns the problem as text. */
export function readSubset(table: SyncTable, input: unknown): [string, undefined] | [undefined, SyncValues] {
  if (input === undefined) return [undefined, {}]
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["`where` must be an object of column values, such as `{\"issueId\":\"i1\"}`.", undefined]
  const subset: SyncValues = {}
  for (const [name, value] of Object.entries(input)) {
    if (!(name in table.columns)) return [`\`where\` has \`${name}\`, which is not a column of the table "${table.name}".`, undefined]
    if (!isSingle(value)) return [`\`where.${name}\` must be one text, number, boolean, or null value.`, undefined]
    subset[name] = value
  }
  return [undefined, subset]
}

/** Whether a value of a row is allowed by one value of the scope: equal to a single value, or one of a list. */
export function allows(scopeValue: unknown, value: unknown): boolean {
  return Array.isArray(scopeValue) ? scopeValue.some(item => sameValue(item, value)) : sameValue(scopeValue, value)
}

/**
 * Adds the subset of the client to the values of `where`. A subset can only narrow them. Returns the first column whose
 * subset value `where` does not allow.
 */
export function mergeSubset(values: SyncValues, subset: SyncValues): [string, undefined] | [undefined, SyncValues] {
  const merged: SyncValues = { ...values }
  for (const [name, value] of Object.entries(subset)) {
    if (name in values && !allows(values[name], value)) return [name, undefined]
    merged[name] = value
  }
  return [undefined, merged]
}

/** Whether a row, such as the stored copy of a deleted row, has every value of the scope. */
export function rowInScope(row: Record<string, unknown>, values: SyncValues): boolean {
  return Object.entries(values).every(([name, value]) => allows(value, row[name] ?? null))
}

/** A value as the column stores it, for `json_each()`. */
function driverValue(table: SyncTable, name: string, value: unknown): string | number {
  const target = column(table, name)
  const stored: unknown = target.mapToDriverValue(decode(table, name, value))
  if (typeof stored === "string" || typeof stored === "number") return stored
  if (typeof stored === "boolean") return stored ? 1 : 0
  if (typeof stored === "bigint") return Number.isSafeInteger(Number(stored)) ? Number(stored) : stored.toString()
  throw syncErrors.SYNC_INVALID_DEFINITION({ message: `[vitehub] \`where\` returned a list for \`${name}\` of the table "${table.name}". Lists work on text, number, and boolean columns only.` })
}

/**
 * A list as one SQL parameter: `column IN (SELECT value FROM json_each(?))`. D1 allows at most 100 parameters in a
 * statement, and a user can be in more teams than that.
 */
function listSql(table: SyncTable, name: string, list: readonly unknown[]): SQL {
  if (!list.length) return sql`1 = 0`
  const target = column(table, name)
  const values = list.filter(value => value !== null).map(value => driverValue(table, name, value))
  const conditions: SQL[] = []
  if (values.length) conditions.push(sql`${target} IN (SELECT value FROM json_each(${JSON.stringify(values, jsonReplacer)}))`)
  if (values.length < list.length) conditions.push(isNull(target))
  // SAFETY: `conditions` has at least one entry, so `or()` returns a condition.
  return or(...conditions)!
}

/** The SQL filter of the scope values. */
export function scopeSql(table: SyncTable, values: SyncValues): SQL | undefined {
  return and(...Object.entries(values).map(([name, value]) => {
    if (Array.isArray(value)) return listSql(table, name, value)
    return value === null ? isNull(column(table, name)) : eq(column(table, name), decode(table, name, value))
  }))
}
