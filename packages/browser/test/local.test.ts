import { describe, expect, it } from "vitest"

import { BrowserProviderError } from "../src/errors.ts"
import { localBrowser } from "../src/providers/local.ts"

describe("localBrowser", () => {
  it("turns asynchronous Chromium spawn failures into provider errors", async () => {
    const provider = localBrowser({ executablePath: "/vitehub/does-not-exist/chromium" })

    await expect(provider.open()).rejects.toBeInstanceOf(BrowserProviderError)
  })
})
