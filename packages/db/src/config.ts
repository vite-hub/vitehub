import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

import type { DBModuleOptions, ResolvedDBViteConfig, ResolvedDrizzleDBConfig } from "./types.ts"

const schemaFilePattern = /\.[cm]?[jt]s$/i

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new TypeError(`\`${label}\` must be a plain object.`)
  }
}

function readStringList(value: unknown, label: string) {
  if (typeof value === "undefined") {
    return []
  }

  if (!Array.isArray(value)) {
    throw new TypeError(`\`${label}\` must be an array of strings.`)
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
}

function normalizeConnectionValue(value: string) {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

function resolveDefaultSchemaPaths(rootDir: string) {
  const schemaPaths: string[] = []
  const schemaEntry = resolve(rootDir, "src/db/schema.ts")
  if (existsSync(schemaEntry)) {
    schemaPaths.push(schemaEntry)
  }

  const schemaDir = resolve(rootDir, "src/db/schema")
  if (!existsSync(schemaDir)) {
    return schemaPaths
  }

  for (const entry of readdirSync(schemaDir, { withFileTypes: true })) {
    if (!entry.isFile() || !schemaFilePattern.test(entry.name)) {
      continue
    }
    schemaPaths.push(resolve(schemaDir, entry.name))
  }

  return schemaPaths
}

function resolveConfiguredSchemaPaths(rootDir: string, schemaPaths: string[]) {
  return schemaPaths.map((entry) => {
    const resolved = resolve(rootDir, entry)
    if (!existsSync(resolved)) {
      throw new Error(`[vitehub] Drizzle schema path not found: ${entry}`)
    }
    return resolved
  })
}

export function normalizeDBOptions(options?: DBModuleOptions): ResolvedDrizzleDBConfig | undefined {
  if (options === false) {
    return
  }

  if (typeof options !== "undefined") {
    assertPlainObject(options, "db")
  }

  const input = options || {}
  const orm = input.orm
  if (typeof orm !== "undefined" && orm !== "drizzle") {
    throw new TypeError("`db.orm` must be `drizzle`.")
  }

  const dialect = input.dialect
  if (typeof dialect !== "undefined" && dialect !== "sqlite") {
    throw new TypeError("`db.dialect` must be `sqlite` in the current Vite slice.")
  }

  if (typeof input.connection !== "undefined") {
    assertPlainObject(input.connection, "db.connection")
  }

  if (typeof input.drizzle !== "undefined") {
    assertPlainObject(input.drizzle, "db.drizzle")
  }

  const rawUrl = input.connection?.url
  if (typeof rawUrl !== "undefined" && (typeof rawUrl !== "string" || rawUrl.trim().length === 0)) {
    throw new TypeError("`db.connection.url` must be a non-empty string when provided.")
  }
  const rawAuthToken = input.connection?.authToken
  if (typeof rawAuthToken !== "undefined" && (typeof rawAuthToken !== "string" || rawAuthToken.trim().length === 0)) {
    throw new TypeError("`db.connection.authToken` must be a non-empty string when provided.")
  }
  const url = typeof rawUrl === "string" ? normalizeConnectionValue(rawUrl) : undefined
  if (typeof rawUrl !== "undefined" && !url) {
    throw new TypeError("`db.connection.url` must be a non-empty string when provided.")
  }
  const authToken = typeof rawAuthToken === "string" ? normalizeConnectionValue(rawAuthToken) : undefined
  if (typeof rawAuthToken !== "undefined" && !authToken) {
    throw new TypeError("`db.connection.authToken` must be a non-empty string when provided.")
  }

  const casing = input.drizzle?.casing
  if (typeof casing !== "undefined" && casing !== "snake_case" && casing !== "camelCase") {
    throw new TypeError("`db.drizzle.casing` must be `snake_case` or `camelCase`.")
  }

  return {
    connection: {
      authToken: authToken || undefined,
      url: url || "file:.data/db/sqlite.db",
    },
    dialect: "sqlite",
    drizzle: {
      casing,
      migrationsDirs: readStringList(input.drizzle?.migrationsDirs, "db.drizzle.migrationsDirs").length
        ? readStringList(input.drizzle?.migrationsDirs, "db.drizzle.migrationsDirs")
        : ["src/db/migrations"],
      schemaPaths: readStringList(input.drizzle?.schemaPaths, "db.drizzle.schemaPaths"),
    },
    orm: "drizzle",
  }
}

export function resolveDBViteConfig(options?: DBModuleOptions, rootDir = process.cwd()): ResolvedDBViteConfig | undefined {
  const db = normalizeDBOptions(options)
  if (!db) {
    return
  }

  const defaultSchemaPaths = resolveDefaultSchemaPaths(rootDir)
  const configuredSchemaPaths = resolveConfiguredSchemaPaths(rootDir, db.drizzle.schemaPaths)
  const schemaPaths = [...new Set([...defaultSchemaPaths, ...configuredSchemaPaths])].sort()

  return {
    db,
    rootDir,
    schemaPaths,
  }
}
