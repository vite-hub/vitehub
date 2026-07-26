import { describe, it } from "vitest"

import { verifyBuiltPackageExports } from "../../internal/test-utils/built-package-exports.js"

describe("@vite-hub/box package contract", () => {
  it("loads documented exports from built package targets", async () => {
    await verifyBuiltPackageExports(new URL("../", import.meta.url), "@vite-hub/box", [
      ".",
      "./_internal/cloudflare",
      "./_internal/vercel",
    ])
  })
})
