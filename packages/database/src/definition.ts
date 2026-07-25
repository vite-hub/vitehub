import { isPlainObject } from "@vite-hub/internal/object"

import { createDefinitionRuntime } from "#vitehub/database/definition-runtime"

import type { Database, DatabaseDefinition, DatabaseDefinitionOptions } from "./types.ts"

const allowedDefinitionKeys = new Set(["cloudflare", "connection", "drizzle", "name", "schema"])

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError(`\`${label}\` must be a plain object.`)
  }
}

export function defineDatabase<TSchema extends Record<string, unknown>>(
  options: DatabaseDefinitionOptions<TSchema>,
): Database<TSchema> {
  assertPlainObject(options, "defineDatabase()")

  const unknownKey = Object.keys(options).find(key => !allowedDefinitionKeys.has(key))
  if (unknownKey) {
    throw new TypeError(`\`defineDatabase()\` does not support the "${unknownKey}" option.`)
  }

  assertPlainObject(options.schema, "defineDatabase().schema")

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

  const name = options.name?.trim() || "default"
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new TypeError("`defineDatabase().name` must use letters, numbers, dots, underscores, or dashes.")
  }

  const definition: DatabaseDefinition<TSchema> = {
    ...(options.cloudflare ? { cloudflare: options.cloudflare } : {}),
    ...(options.connection ? { connection: options.connection } : {}),
    dialect: "sqlite",
    drizzle: casing ? { casing } : {},
    name,
    schema: options.schema,
  }
  const runtime = createDefinitionRuntime(definition)

  return new Proxy(definition as Database<TSchema>, {
    get(target, property, receiver) {
      return Reflect.has(target, property) ? Reflect.get(target, property, receiver) : Reflect.get(runtime, property)
    },
  })
}
