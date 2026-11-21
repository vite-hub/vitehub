import { expect, it } from "vitest"

import { commentsMigrationSql } from "../src/database.ts"
import { commentsErrorDiagnostics } from "../src/operations-core/errors.ts"

/** The codes that replaced plain errors in the migration helpers and the GitHub login. */
const codes = [
  "COMMENTS_GITHUB_REQUEST_FAILED",
  "COMMENTS_MIGRATION_DATABASE_UNSUPPORTED",
  "COMMENTS_MIGRATION_LIVE_POSTGRES",
  "COMMENTS_SECRET_TOO_SHORT",
] as const

it.each(codes)("gives %s a fix and its own docs page", (code) => {
  // Each code takes its own params. One object that has all of them fits every code.
  const create = commentsErrorDiagnostics[code] as (params: { dialect: "sqlite", minimum: number, path: string, status: number }) => Error & { docs?: string, fix?: string }
  const error = create({ dialect: "sqlite", minimum: 32, path: "/user", status: 401 })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/comments/diagnostics/${code.toLowerCase()}`)
})

it("reports a live-site migration of a Postgres Database with its code and fix", () => {
  expect(() => commentsMigrationSql({ dialect: "postgresql", from: "live" })).toThrow(expect.objectContaining({
    code: "COMMENTS_MIGRATION_LIVE_POSTGRES",
    fix: expect.stringContaining("from: \"outdated\""),
    message: "[vitehub] The live-site comments model had no Postgres tables, so there is nothing to move.",
  }))
})
