import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  assertExampleOutputs,
  assertManifestCompleteness,
  cleanExampleOutput,
  loadExampleContracts,
} from "./package-examples.mjs"

describe("package example contracts", () => {
  it("lists every package showcase framework exactly once", () => {
    expect(() => assertManifestCompleteness(loadExampleContracts())).not.toThrow()
  })

  it("removes stale output and requires a non-empty declared artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "vitehub-package-example-"))
    mkdirSync(join(root, "dist"), { recursive: true })
    writeFileSync(join(root, "dist", "stale.js"), "stale")

    cleanExampleOutput(root)
    expect(() => assertExampleOutputs({ id: "fixture", framework: "vite", outputs: ["dist/server.js"] }, root))
      .toThrow("fixture:vite did not emit dist/server.js")

    mkdirSync(join(root, "dist"), { recursive: true })
    writeFileSync(join(root, "dist", "server.js"), "export default {}")
    expect(() => assertExampleOutputs({ id: "fixture", framework: "vite", outputs: ["dist/server.js"] }, root)).not.toThrow()
  })
})
