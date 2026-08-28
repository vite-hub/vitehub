import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@vite-hub/internal/arrays", () => ({
  toArray: (value: unknown) => Array.isArray(value) ? value : [value],
}))

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
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

  it.each([
    {
      expectedSiteID: "explicit-site",
      expectedToken: "context-token",
      options: { siteID: "explicit-site" },
    },
    {
      expectedSiteID: "context-site",
      expectedToken: "explicit-token",
      options: { token: "explicit-token" },
    },
  ])("uses one resolved credential pair for real SDK and list requests", async ({ expectedSiteID, expectedToken, options }) => {
    const context = btoa(JSON.stringify({
      apiURL: "https://blobs.example.test",
      siteID: "context-site",
      token: "context-token",
    }))
    vi.stubGlobal("netlifyBlobsContext", context)
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => init?.method === "HEAD"
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify({ blobs: [], directories: [] }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const { createDriver } = await import("../src/drivers/netlify-blobs.ts")
    const driver = createDriver({ driver: "netlify-blobs", name: "vitehub-blob", ...options })
    await driver.head("proof.txt")
    await driver.list()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetchMock.mock.calls) {
      expect(new URL(input.toString()).pathname).toContain(`/${expectedSiteID}/site:vitehub-blob`)
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${expectedToken}`)
    }
  })

  it("uses one resolved credential pair for real deploy-scoped SDK and list requests", async () => {
    vi.stubGlobal("netlifyBlobsContext", btoa(JSON.stringify({
      apiURL: "https://blobs.example.test",
      deployID: "deployid",
      siteID: "context-site",
      token: "context-token",
    })))
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ blobs: [], directories: [] }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const { createDriver } = await import("../src/drivers/netlify-blobs.ts")
    const driver = createDriver({
      deployScoped: true,
      driver: "netlify-blobs",
      name: "vitehub-blob",
      token: "explicit-token",
    })
    await driver.head("proof.txt")
    await driver.list()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [input, init] of fetchMock.mock.calls) {
      expect(new URL(input.toString()).pathname).toContain("/context-site/deploy:deployid:vitehub-blob")
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer explicit-token")
    }
  })

  it("keeps strong listing on the API endpoint when edge mode is inactive", async () => {
    vi.stubGlobal("netlifyBlobsContext", btoa(JSON.stringify({
      apiURL: "https://api.example.test",
      siteID: "context-site",
      token: "context-token",
      uncachedEdgeURL: "https://uncached.example.test",
    })))
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => init?.method === "HEAD"
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify({ blobs: [], directories: [] }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const { createDriver } = await import("../src/drivers/netlify-blobs.ts")
    const driver = createDriver({ consistency: "strong", driver: "netlify-blobs", name: "vitehub-blob" })
    await driver.head("proof.txt")
    await driver.list()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [input] of fetchMock.mock.calls) {
      const url = new URL(input.toString())
      expect(url.origin).toBe("https://api.example.test")
      expect(url.pathname).toContain("/api/v1/blobs/context-site/site:vitehub-blob")
    }
  })
})
