import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { databaseErrorDiagnostics } from "../src/error-diagnostics.ts"
import { migrateD1Http, migratePostgresDatabases, readMigrationPlan } from "../src/internal/migration-plan.ts"
import { chunkParameters } from "../src/runtime/chunk-parameters.ts"

import type { ResolvedDrizzleDatabaseConfig } from "../src/types.ts"

/** The codes that replaced the marked plain errors of chunkParameters() and D1 HTTP migrations. */
const codes = [
  "DATABASE_CHUNK_INVALID_COUNT",
  "DATABASE_CHUNK_VALUE_TOO_LARGE",
  "DATABASE_D1_MIGRATION_FAILED",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  // Each code takes its own params. One object that has all of them fits every code.
  const create = databaseErrorDiagnostics[code] as (params: { database: string, limit: number, min: number, name: string, per: number, problem: string, reserved: number, value: number }) => Error & { docs?: string, fix?: string }
  const error = create({ database: "default", limit: 100, min: 1, name: "per", per: 1, problem: "m", reserved: 0, value: 0 })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/database/diagnostics/${code.toLowerCase()}`)
})

it("throws chunkParameters() argument errors with their code and fix", () => {
  expect(() => chunkParameters([1], { per: 0 })).toThrow(expect.objectContaining({ code: "DATABASE_CHUNK_INVALID_COUNT", fix: expect.stringContaining("chunkParameters(values, { per, reserved, limit })") }))
  expect(() => chunkParameters([1], { per: 60, reserved: 50 })).toThrow(expect.objectContaining({ code: "DATABASE_CHUNK_VALUE_TOO_LARGE", fix: expect.stringContaining("`limit`") }))
})

/** A D1 HTTP Database with no Cloudflare credentials in the environment. */
// SAFETY: The migration plan reads only these fields of a resolved Database config.
const d1Http = { cloudflare: { binding: "DB", databaseId: "db-uuid", http: true }, dialect: "sqlite", migrationsDir: "migrations", name: "default" } as ResolvedDrizzleDatabaseConfig

it("reports missing D1 HTTP credentials of `vitehub database migrate` with the code of the step", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-database-d1-http-"))
  try {
    const database = { ...d1Http, migrationsDir: join(root, "migrations") }
    await expect(migrateD1Http(database, { env: {}, projectRoot: root }, () => {}, () => {})).resolves.toMatchObject({
      code: "DATABASE_D1_MIGRATION_FAILED",
      fix: expect.stringContaining("CLOUDFLARE_API_TOKEN"),
      message: expect.stringContaining("needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`"),
    })
    const [error] = await readMigrationPlan(database, { env: {}, projectRoot: root })
    expect(error).toMatchObject({ code: "DATABASE_MIGRATION_CHECK_FAILED", message: expect.stringContaining("needs `CLOUDFLARE_ACCOUNT_ID`") })
  }
  finally {
    await rm(root, { force: true, recursive: true })
  }
})

it("raises INTERNAL_INVARIANT_FAILED when the CLI passes a database that is not Postgres to the Postgres migrator", async () => {
  await expect(migratePostgresDatabases([d1Http], { allowDataLoss: false, env: {}, projectRoot: tmpdir() }, () => {})).resolves.toMatchObject({
    code: "INTERNAL_INVARIANT_FAILED",
  })
})
