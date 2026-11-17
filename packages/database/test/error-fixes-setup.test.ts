import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { databaseErrorDiagnostics } from "../src/error-diagnostics.ts"
import { migratePostgresDatabases } from "../src/internal/migration-plan.ts"

import type { ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

/** The codes that replaced plain errors in the Nuxt module and the migration CLI. */
const codes = [
  "DATABASE_D1_MIGRATIONS_DIR_INVALID",
  "DATABASE_D1_MIGRATIONS_DIR_OVERLAP",
  "DATABASE_NUXT_CONTENT_D1_MISSING",
  "DATABASE_POSTGRES_DRIVER_MISSING",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  // Each code takes its own params. One object that has all of them fits every code.
  const create = databaseErrorDiagnostics[code] as (params: { first: string, name: "pg", second: string }) => Error & { docs?: string, fix?: string }
  const error = create({ first: "DB", name: "pg", second: "CONTENT_DB" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/database/diagnostics/${code.toLowerCase()}`)
})

it("reports a missing Postgres driver of `vitehub database migrate` with its code and fix", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-database-driver-"))
  try {
    await writeFile(join(root, "package.json"), "{\"private\":true}")
    // pnpm puts its own packages on NODE_PATH, so give the project a `pg` that cannot load instead of none.
    await mkdir(join(root, "node_modules/pg"), { recursive: true })
    await writeFile(join(root, "node_modules/pg/package.json"), JSON.stringify({ main: "index.js", name: "pg" }))
    await writeFile(join(root, "node_modules/pg/index.js"), "throw new Error('pg is not installed')\n")
    await mkdir(join(root, "migrations"))
    // SAFETY: The migration plan reads only these fields of a resolved Database config.
    const database = { connection: { url: "postgres://127.0.0.1:1/app" }, dialect: "postgresql", driver: "node-postgres", migrationsDir: join(root, "migrations"), name: "default" } as ResolvedDrizzleDatabaseConfig
    const error = await migratePostgresDatabases([database], { allowDataLoss: false, env: {}, projectRoot: root }, () => {})
    expect(error).toMatchObject({
      code: "DATABASE_POSTGRES_DRIVER_MISSING",
      fix: expect.stringContaining("pnpm add pg"),
      message: "Cannot load the `pg` package from the project. Install it, for example with `pnpm add pg`.",
    })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})
