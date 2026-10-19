import { readFile } from "node:fs/promises"

import { expect, it } from "vitest"

import { connectionsErrorDiagnostics } from "../src/error-diagnostics.ts"

it("documents every Connections error code", async () => {
  const page = await readFile(new URL("../../../docs/content/docs/connections/limits-and-errors.md", import.meta.url), "utf8")
  for (const code of Object.keys(connectionsErrorDiagnostics)) expect(page, code).toContain(`\n### ${code}\n`)
  const error = connectionsErrorDiagnostics.CONNECTIONS_INVALID_INPUT()
  expect(error.docs).toBe("https://vitehub.dev/docs/connections/limits-and-errors#connections_invalid_input")
  expect(error.why).not.toBe("")
  expect(error.fix).not.toBe("")
})
