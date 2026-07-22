import { describe, expect, it } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { localBrowser } from "../src/providers/local.ts"

describe("localBrowser", () => {
  it("turns asynchronous Chromium spawn failures into provider errors", async () => {
    const provider = localBrowser({ executablePath: "/vitehub/does-not-exist/chromium" })

    await expect(provider.open()).rejects.toBeInstanceOf(ViteHubError)
    await expect(provider.open()).rejects.toMatchObject({ code: "BROWSER_PROVIDER_ERROR" })
  })
})
