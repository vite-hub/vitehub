import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

import { readDiagnosticCatalogs } from "../../../docs/modules/diagnostics/catalog.ts"

import { kvErrorDiagnostics } from "../src/error-diagnostics.ts"

it("documents each KV error code with a why, a fix, and a generated docs page", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  const catalog = readDiagnosticCatalogs(root).find(entry => entry.file === "packages/kv/src/error-diagnostics.ts")!

  expect(catalog.codes.map(entry => entry.code).sort()).toEqual(Object.keys(kvErrorDiagnostics).sort())
  for (const entry of catalog.codes) {
    expect(entry.fix, entry.code).toBeTruthy()
    expect(entry.docsBase, entry.code).toBe("https://vitehub.dev/docs/kv/diagnostics")
  }
  const error = kvErrorDiagnostics.KV_INVALID_LIMIT()
  expect(error.docs).toBe("https://vitehub.dev/docs/kv/diagnostics/kv_invalid_limit")
  expect(error.why).not.toBe("")
  expect(error.fix).not.toBe("")
})
