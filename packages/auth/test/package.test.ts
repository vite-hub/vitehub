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
      "./agent",
      "./package.json",
      "./server",
      "./vite",
    ])
  })

  it("loads documented exports from built package targets", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/auth", [
      ".",
      "./agent",
      "./server",
      "./vite",
    ])
  })
})
