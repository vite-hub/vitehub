import { execFileSync } from "node:child_process"

import { expect, it } from "vitest"

import { databaseErrorDiagnostics } from "../src/error-diagnostics.ts"

it("gives each Database error code a why, a fix, and its docs page", () => {
  const error = databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: "analytics" })
  expect(error.docs).toBe("https://vitehub.dev/docs/database/diagnostics/database_not_found")
  expect(error.why).toBe("The database \"analytics\" is not configured.")
  expect(error.fix).not.toBe("")
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    code: "DATABASE_NOT_FOUND",
    docs: "https://vitehub.dev/docs/database/diagnostics/database_not_found",
    fix: error.fix,
    name: "DATABASE_NOT_FOUND",
    why: error.why,
  })
})

it("requires verified history before reverting to the default Postgres ledger", () => {
  const params = {
    database: "default",
    migrations: [{ hash: "hash", name: "20260101000000_init", when: 1767225600000 }],
    recorded: 0,
    schema: "app",
  }
  const verified = databaseErrorDiagnostics.DATABASE_MIGRATION_LEDGER_MISPLACED({ ...params, unverified: [] })
  expect(verified.fix).toContain('only if you verify that the ledger in "drizzle" lists all migrations this app has applied')
  const ambiguous = databaseErrorDiagnostics.DATABASE_MIGRATION_LEDGER_MISPLACED({ ...params, unverified: ["20260102000000_clear"] })
  expect(ambiguous.fix).not.toContain("Remove `migrationsSchema`")
})

it("names the schema owner for a schema grant and quotes the SQL for the shell", () => {
  const fix = databaseErrorDiagnostics.DATABASE_MIGRATION_SCHEMA_DENIED({ database: "default", missing: "usage", postgresDatabase: "app", role: "o'neil", schema: "team's ledger" }).fix ?? ""
  const statement = `GRANT USAGE ON SCHEMA "team's ledger" TO "o'neil"`
  expect(fix).toContain(`As the owner of the schema "team's ledger" or a role with the grant option on it, run \`${statement}\``)
  const argument = fix.match(/--database default (.+)` with that role/)?.[1]
  expect(execFileSync("sh", ["-c", `printf %s ${argument}`], { encoding: "utf8" })).toBe(statement)
  expect(databaseErrorDiagnostics.DATABASE_MIGRATION_SCHEMA_DENIED({ database: "default", missing: "create-database", postgresDatabase: "app", role: "app_user", schema: "drizzle" }).fix).toMatch(/^As a role that owns the database, /)
})
