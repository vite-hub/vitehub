import { describe, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"

describe("@vite-hub/sandbox package contract", () => {
  it("loads documented exports from built package targets", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/sandbox", [
      ".",
      "./_internal/cloudflare",
      "./_internal/toolchain",
      "./_internal/vercel",
    ])
  })
})
