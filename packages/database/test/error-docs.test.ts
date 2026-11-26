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
