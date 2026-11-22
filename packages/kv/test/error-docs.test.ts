import { readFile } from "node:fs/promises"
import { expect, it } from "vitest"

import { kvErrorDiagnostics } from "../src/error-diagnostics.ts"

it("documents each legacy KV error code with a heading and links to generated diagnostics", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/kv/limits-and-errors.md", import.meta.url), "utf8")
  const legacy = new Set((await readFile(new URL("../../../test/fixtures/legacy-diagnostic-codes.txt", import.meta.url), "utf8")).split("\n"))

  for (const code of Object.keys(kvErrorDiagnostics).filter(code => legacy.has(code))) {
    expect(page, code).toContain(`\n### ${code}\n`)
  }
  const error = kvErrorDiagnostics.KV_INVALID_LIMIT()
  expect(error.docs).toBe("https://vitehub.dev/docs/kv/diagnostics/kv_invalid_limit")
  expect(error.why).not.toBe("")
  expect(error.fix).not.toBe("")
})
