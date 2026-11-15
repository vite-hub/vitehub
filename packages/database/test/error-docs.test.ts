import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"

import { databaseErrorDiagnostics } from "../src/error-diagnostics.ts"

it("documents each Database error code with a why, a fix, and a docs heading", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/database/limits-and-errors.md", import.meta.url), "utf8")
  // A code after the legacy list gets only its generated page. test/diagnostic-codes.test.ts keeps it off this page.
  const legacy = new Set((await readFile(new URL("../../../test/fixtures/legacy-diagnostic-codes.txt", import.meta.url), "utf8")).split("\n"))

  for (const code of Object.keys(databaseErrorDiagnostics).filter(code => legacy.has(code))) {
    expect(page, code).toContain(`\n### ${code}\n`)
  }
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
