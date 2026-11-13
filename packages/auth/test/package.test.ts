import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, unknown>
}

describe("@vite-hub/auth package contract", () => {
  it("exposes only the documented public entrypoints", () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual([
      ".",
      "./abilities",
      "./agent",
      "./cli",
      "./console",
      "./console-runtime",
      "./database",
      "./mcp",
      "./nuxt",
      "./package.json",
      "./presets",
      "./runtime/console",
      "./runtime/server",
      "./schema",
      "./server",
      "./vite",
      "./vue",
    ])
  })

  // Give each fresh Node process its own timeout and report the failing entrypoint.
  it.each([
    ".",
    "./agent",
    "./cli",
    "./console",
    "./console-runtime",
    "./database",
    "./mcp",
    "./nuxt",
    "./presets",
    "./runtime/console",
    "./runtime/server",
    "./schema",
    "./server",
    "./vue",
    "./vite",
  ])("loads documented export %s from the built package", async (entry) => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/auth", [entry])
  })
})
