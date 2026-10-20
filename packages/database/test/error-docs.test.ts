import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"

import { databaseErrorDiagnostics } from "../src/error-diagnostics.ts"

it("documents each Database error code with a why, a fix, and a docs heading", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/database/limits-and-errors.md", import.meta.url), "utf8")

  for (const code of Object.keys(databaseErrorDiagnostics)) {
    expect(page, code).toContain(`\n### ${code}\n`)
  }
  const error = databaseErrorDiagnostics.DATABASE_NOT_FOUND({ database: "analytics" })
  expect(error.docs).toBe("https://vitehub.dev/docs/database/limits-and-errors#database_not_found")
  expect(error.why).toBe("The database \"analytics\" is not configured.")
  expect(error.fix).not.toBe("")
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    code: "DATABASE_NOT_FOUND",
    docs: "https://vitehub.dev/docs/database/limits-and-errors#database_not_found",
    fix: error.fix,
    name: "DATABASE_NOT_FOUND",
    why: error.why,
  })
})
