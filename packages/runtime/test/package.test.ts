import { describe, expect, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"
import manifest from "../package.json" with { type: "json" }

describe("@vite-hub/runtime package contract", () => {
  it("loads documented exports from built package targets", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/runtime", [".", "./operations", "./internal/drain", "./internal/h3", "./internal/node"])
  })

  it("publishes no executable, since `vitehub drain` runs from the vite-hub bin", () => {
    expect(manifest).not.toHaveProperty("bin")
  })
})
