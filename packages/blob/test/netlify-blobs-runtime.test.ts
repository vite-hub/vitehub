import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe("Netlify Blobs runtime", () => {
  it("imports and constructs an explicit store without reading protected Deno env", async () => {
    const getEnvironmentVariable = vi.fn(() => {
      throw new Error("Requires env access")
    })
    vi.stubGlobal("Deno", { env: { get: getEnvironmentVariable } })

    const { getStore } = await import("@vite-hub/netlify-blobs-runtime")
    const store = getStore({ name: "vitehub-blob", siteID: "site-id", token: "secret" })

    expect(store).toBeDefined()
    expect(getEnvironmentVariable).not.toHaveBeenCalled()
  })
})
