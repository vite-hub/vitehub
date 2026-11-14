import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineDiagnostics } from "nostics"
import { build } from "vite"
import { afterEach, expect, it, vi } from "vitest"

import type { Plugin } from "vite"

import { withPrintedDiagnostics } from "../src/hook-errors.ts"

const diagnostics = defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/development/diagnostics",
  codes: {
    VITE_HUB_TEST: { why: "Blob is disabled but the app imports vite-hub/blob.", fix: "Set `blob: true` in `vitehub()`." },
  },
})

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function buildWith(plugin: Plugin) {
  const root = mkdtempSync(join(tmpdir(), "vitehub-hook-errors-"))
  roots.push(root)
  writeFileSync(join(root, "main.js"), "export const value = 1\n")
  return build({ root, configFile: false, logLevel: "silent", build: { write: false, lib: { entry: join(root, "main.js"), formats: ["es"] } }, plugins: withPrintedDiagnostics([plugin]) })
}

it("prints the fix and docs link of an error that a build hook throws", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
  const error = diagnostics.VITE_HUB_TEST()

  await expect(buildWith({ name: "throws", buildStart() { throw error } })).rejects.toThrow("Blob is disabled")

  const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("")
  expect(output).toContain("[VITE_HUB_TEST] Blob is disabled but the app imports vite-hub/blob.")
  expect(output).toContain("fix: Set `blob: true` in `vitehub()`.")
  expect(output).toContain("see: https://vitehub.dev/docs/development/diagnostics/vite_hub_test")
})

it("prints the fix of a rejected async hook with a filter, once", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
  const error = diagnostics.VITE_HUB_TEST()
  const plugin: Plugin = { name: "throws", transform: { filter: { id: /main\.js$/ }, async handler() { throw error } } }

  await expect(buildWith(plugin)).rejects.toThrow("Blob is disabled")

  const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join("")
  expect(output.match(/fix: Set `blob: true`/g)).toHaveLength(1)
})

it("leaves plain errors and the plugin objects as they are", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
  const plugin: Plugin = { name: "plain", buildStart() { throw new Error("plain failure") } }

  expect(withPrintedDiagnostics([plugin])[0]).toBe(plugin)
  await expect(buildWith(plugin)).rejects.toThrow("plain failure")
  expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain("plain failure")
})
