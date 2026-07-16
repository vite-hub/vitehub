import { isPlainObject } from "@vite-hub/internal/object"

import type { DatabaseDefinition, DatabaseDefinitionOptions } from "./types.ts"

const allowedDefinitionKeys = new Set(["cloudflare", "connection", "drizzle", "tables"])

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError(`\`${label}\` must be a plain object.`)
  }
}

export function defineDatabase<TTables extends Record<string, unknown>>(
  options: DatabaseDefinitionOptions<TTables>,
): DatabaseDefinition<TTables> {
  assertPlainObject(options, "defineDatabase()")

  const unknownKey = Object.keys(options).find(key => !allowedDefinitionKeys.has(key))
  if (unknownKey) {
    throw new TypeError(`\`defineDatabase()\` does not support the "${unknownKey}" option.`)
  }

  assertPlainObject(options.tables, "defineDatabase().tables")

  if (typeof options.cloudflare !== "undefined") {
    assertPlainObject(options.cloudflare, "defineDatabase().cloudflare")
    if (options.cloudflare.http !== true && typeof options.cloudflare.http !== "undefined") {
      assertPlainObject(options.cloudflare.http, "defineDatabase().cloudflare.http")
    }
  }
  if (typeof options.connection !== "undefined") {
    assertPlainObject(options.connection, "defineDatabase().connection")
  }
  if (typeof options.drizzle !== "undefined") {
    assertPlainObject(options.drizzle, "defineDatabase().drizzle")
  }

  const casing = options.drizzle?.casing
  if (typeof casing !== "undefined" && casing !== "snake_case" && casing !== "camelCase") {
    throw new TypeError("`defineDatabase().drizzle.casing` must be `snake_case` or `camelCase`.")
  }

  return {
    ...(options.cloudflare ? { cloudflare: options.cloudflare } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
    dialect: "sqlite",
    drizzle: {
      ...(casing ? { casing } : {}),
    },
    tables: options.tables,
  }
}
