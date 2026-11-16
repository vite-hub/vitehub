import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { format } from "node:util"

import { defineDiagnostics } from "nostics"
import { build } from "vite"
import { afterEach, expect, it, vi } from "vitest"

import type { Plugin, PluginOption } from "vite"

import { withPrintedDiagnostics } from "../src/hook-errors.ts"
import { withCmsPresetPlugins } from "../src/internal/cms-preset-features.ts"

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

/** What the console prints for the calls, with the cause after the message. */
function printedOutput(calls: unknown[][]) {
  return calls.map(args => format(...args)).join("\n")
}

function buildWith(plugin: Plugin) {
  return buildRoot(appRoot(), withPrintedDiagnostics([plugin]))
}

function appRoot() {
  const root = mkdtempSync(join(tmpdir(), "vitehub-hook-errors-"))
  roots.push(root)
  writeFileSync(join(root, "main.js"), "export const value = 1\n")
  return root
}

function buildRoot(root: string, plugins: PluginOption[]) {
  return build({ root, configFile: false, logLevel: "silent", build: { write: false, lib: { entry: join(root, "main.js"), formats: ["es"] } }, plugins })
}

it("prints the fix and docs link of an error that a build hook throws", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
  const error = diagnostics.VITE_HUB_TEST()

  await expect(buildWith({ name: "throws", buildStart() { throw error } })).rejects.toThrow("Blob is disabled")

  const output = printedOutput(stderr.mock.calls)
  expect(output).toContain("[VITE_HUB_TEST] Blob is disabled but the app imports vite-hub/blob.")
  expect(output).toContain("fix: Set `blob: true` in `vitehub()`.")
  expect(output).toContain("see: https://vitehub.dev/docs/development/diagnostics/vite_hub_test")
})

it("prints the cause of a diagnostic after its fix", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
  const cause = new Error("YAML does not parse at line 3")
  const error = diagnostics.VITE_HUB_TEST({ cause })

  await expect(buildWith({ name: "throws", buildStart() { throw error } })).rejects.toThrow("Blob is disabled")

  expect(stderr).toHaveBeenCalledWith("%s", expect.stringContaining("fix: Set `blob: true` in `vitehub()`."), cause)
  expect(printedOutput(stderr.mock.calls)).toContain("YAML does not parse at line 3")
})

it("prints the fix of a rejected async hook with a filter, once", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
  const error = diagnostics.VITE_HUB_TEST()
  const plugin: Plugin = { name: "throws", transform: { filter: { id: /main\.js$/ }, async handler() { throw error } } }

  await expect(buildWith(plugin)).rejects.toThrow("Blob is disabled")

  const output = printedOutput(stderr.mock.calls)
  expect(output.match(/fix: Set `blob: true`/g)).toHaveLength(1)
})

it("leaves plain errors and the plugin objects as they are", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
  const plugin: Plugin = { name: "plain", buildStart() { throw new Error("plain failure") } }

  expect(withPrintedDiagnostics([plugin])[0]).toBe(plugin)
  await expect(buildWith(plugin)).rejects.toThrow("plain failure")
  expect(printedOutput(stderr.mock.calls)).not.toContain("plain failure")
})

it("prints the fix from the plugins of the CMS preset variant that Vite selects", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
  const error = diagnostics.VITE_HUB_TEST()
  const root = appRoot()
  mkdirSync(join(root, "server"))
  writeFileSync(join(root, "server/content.ts"), `import { defineContent } from '@vite-hub/content'
import { cms } from '@vite-hub/cms'
export default defineContent({ extends: [cms, { store: 'blob-database' }] })`)
  const options = { blob: undefined, database: undefined, workspace: undefined }
  const plugins = withCmsPresetPlugins(options, resolved => withPrintedDiagnostics([{ name: "blob", buildStart() { if (resolved.blob) throw error } }]))

  await expect(buildRoot(root, plugins)).rejects.toThrow("Blob is disabled")

  expect(printedOutput(stderr.mock.calls)).toContain("fix: Set `blob: true` in `vitehub()`.")
})
