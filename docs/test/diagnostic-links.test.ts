import { resolve } from "node:path"

import { expect, it } from "vitest"

import { agentDiagnosticOptions } from "../../packages/agent/src/agent-diagnostic-options"
import { readDiagnosticCodes } from "../modules/diagnostics/catalog"
import { diagnosticPath, diagnosticSection } from "../modules/diagnostics/pages"

// Console codes link to the section of the Console or MCP guide that the Console opens from its error state.
const consoleCatalog = "packages/vite-hub/src/console/runtime/diagnostics.ts"
const codes = readDiagnosticCodes(resolve(import.meta.dirname, "../..")).filter(code => code.file !== consoleCatalog)

it("links each diagnostic code to its own page", () => {
  // A per-code `docs` URL takes precedence over the catalog base.
  const wrong = codes
    .map(code => ({ code: code.code, docs: code.docs ?? `${code.docsBase ?? agentDiagnosticOptions.docsBase}/${code.code.toLowerCase()}`, page: `https://vitehub.dev${diagnosticPath(diagnosticSection(code)!, code.code)}` }))
    .filter(entry => entry.docs !== entry.page)
  expect(wrong).toEqual([])
})

it("reads a string docs base from every catalog except the Agent catalogs, which spread the shared options", () => {
  expect([...new Set(codes.filter(code => !code.docsBase).map(code => code.file))].sort()).toEqual([
    "packages/agent/src/agent-diagnostics.ts",
    "packages/agent/src/message-diagnostics.ts",
  ])
})
