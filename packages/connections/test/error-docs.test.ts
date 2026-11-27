import { readFile } from "node:fs/promises"

import { expect, it } from "vitest"

import { connectionsErrorDiagnostics } from "../src/error-diagnostics.ts"

it("documents every Connections error code", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/connections/limits-and-errors.md", import.meta.url), "utf8")
  const legacy = new Set((await readFile(new URL("../../../test/fixtures/legacy-diagnostic-codes.txt", import.meta.url), "utf8")).split("\n"))
  for (const code of Object.keys(connectionsErrorDiagnostics).filter(code => legacy.has(code))) expect(page, code).toContain(`\n### ${code}\n`)
  const error = connectionsErrorDiagnostics.CONNECTIONS_INVALID_INPUT()
  expect(error.docs).toBe("https://vitehub.dev/docs/connections/diagnostics/connections_invalid_input")
  expect(error.why).not.toBe("")
  expect(error.fix).not.toBe("")
})
