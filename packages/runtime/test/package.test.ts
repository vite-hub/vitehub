import { access, readFile, stat } from "node:fs/promises"

import { describe, expect, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"
import manifest from "../package.json" with { type: "json" }

describe("@vite-hub/runtime package contract", () => {
  it("loads documented exports from built package targets", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/runtime", [".", "./node"])
  })

  it("publishes the drain executable", async () => {
    expect(manifest.bin).toEqual({ "vitehub-drain": "./dist/drain.js" })
    const executable = new URL("../dist/drain.js", import.meta.url)
    await expect(access(executable)).resolves.toBeUndefined()
    await expect(readFile(executable, "utf8")).resolves.toMatch(/^#!\/usr\/bin\/env node/)
    expect((await stat(executable)).mode & 0o111).not.toBe(0)
  })
})
