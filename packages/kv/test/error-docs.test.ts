import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"

import { kvErrorDiagnostics } from "../src/error-diagnostics.ts"

it("documents each KV error code with a why, a fix, and a docs heading", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/kv/limits-and-errors.md", import.meta.url), "utf8")

  for (const code of Object.keys(kvErrorDiagnostics)) {
    expect(page, code).toContain(`\n### ${code}\n`)
  }
  const error = kvErrorDiagnostics.KV_INVALID_LIMIT()
  expect(error.docs).toBe("https://vitehub.dev/docs/kv/limits-and-errors#kv_invalid_limit")
  expect(error.why).not.toBe("")
  expect(error.fix).not.toBe("")
})
