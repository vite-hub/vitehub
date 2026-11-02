import { getTableColumns } from "drizzle-orm"

import type { Table } from "drizzle-orm"

export interface ChunkParametersOptions {
  /** Bound parameters that one value takes. A Drizzle table counts its columns, for a multi-row insert. Default `1`. */
  per?: number | Table
  /** Other bound parameters in the same statement, for example the value of an `eq()` beside the `inArray()`. Default `0`. */
  reserved?: number
  /** The most bound parameters in one statement. Default `100`, the limit of Cloudflare D1 and the lowest of the supported drivers. */
  limit?: number
}

function assertCount(name: string, value: number, min: number) {
  if (!Number.isInteger(value) || value < min) throw new TypeError(`chunkParameters() needs \`${name}\` to be an integer of ${min} or more, not ${value}.`)
}

/**
 * Splits `values` into chunks that fit the bound parameter limit of one statement, so each chunk can go to one
 * `inArray()` or one multi-row `insert().values()`. Each chunk has at most `(limit - reserved) / per` values.
 */
export function chunkParameters<T>(values: readonly T[], options: ChunkParametersOptions = {}): T[][] {
  const per = typeof options.per === "object" ? Object.keys(getTableColumns(options.per)).length : options.per ?? 1
  const reserved = options.reserved ?? 0
  const limit = options.limit ?? 100
  assertCount("per", per, 1)
  assertCount("reserved", reserved, 0)
  assertCount("limit", limit, 1)
  const size = Math.floor((limit - reserved) / per)
  if (size < 1) {
    throw new RangeError(`chunkParameters() cannot fit one value: it takes ${per} bound parameters and the statement has ${reserved} more, over the limit of ${limit}.`)
  }
  const chunks: T[][] = []
  for (let start = 0; start < values.length; start += size) chunks.push(values.slice(start, start + size))
  return chunks
}
