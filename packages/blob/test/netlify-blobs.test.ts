import { beforeEach, describe, expect, it, vi } from "vitest"

const store = vi.hoisted(() => ({
  delete: vi.fn(),
  getMetadata: vi.fn(),
  getWithMetadata: vi.fn(),
  list: vi.fn(),
  set: vi.fn(),
}))
const netlifyStores = vi.hoisted(() => ({
  getDeployStore: vi.fn(() => store),
  getStore: vi.fn(() => store),
}))

vi.mock("@vite-hub/internal/arrays", () => ({
  toArray: (value: unknown) => Array.isArray(value) ? value : [value],
}))
vi.mock("@vite-hub/netlify-blobs-runtime", () => ({
  getDeployStore: netlifyStores.getDeployStore,
  getStore: netlifyStores.getStore,
}))

import { createDriver } from "../src/drivers/netlify-blobs.ts"

const options = { driver: "netlify-blobs", name: "vitehub-blob", siteID: "site-id", token: "secret" } as const

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function mockListPages(pages: Record<string, { blobs: Array<{ etag: string, key: string }>, directories: string[], next_cursor?: string }>) {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = new URL(input.toString())
    const page = pages[url.searchParams.get("cursor") ?? "first"]
    return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }))
  }))
}

describe("Netlify Blobs driver", () => {
  it("uses NETLIFY_BLOBS_CONTEXT for SDK and list requests", async () => {
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", Buffer.from(JSON.stringify({ siteID: "environment-site", token: "environment-token" })).toString("base64"))
    mockListPages({ first: { blobs: [], directories: [] } })

    await createDriver({ driver: "netlify-blobs", name: "vitehub-blob" }).list()

    expect(netlifyStores.getStore).toHaveBeenCalledWith(expect.objectContaining({
      siteID: "environment-site",
      token: "environment-token",
    }))
    const [input, init] = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(input.toString()).pathname).toBe("/api/v1/blobs/environment-site/site:vitehub-blob")
    expect(init).toMatchObject({ headers: { authorization: "Bearer environment-token" } })
  })

  it.each([
    {
      expectedSiteID: "explicit-site",
      expectedToken: "environment-token",
      options: { siteID: "explicit-site" },
    },
    {
      expectedSiteID: "environment-site",
      expectedToken: "explicit-token",
      options: { token: "explicit-token" },
    },
  ])("prefers each explicit credential over its context fallback", async ({ expectedSiteID, expectedToken, options: explicitOptions }) => {
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", Buffer.from(JSON.stringify({ siteID: "environment-site", token: "environment-token" })).toString("base64"))
    mockListPages({ first: { blobs: [], directories: [] } })

    await createDriver({ driver: "netlify-blobs", name: "vitehub-blob", ...explicitOptions }).list()

    expect(netlifyStores.getStore).toHaveBeenCalledWith(expect.objectContaining({
      siteID: expectedSiteID,
      token: expectedToken,
    }))
    const [input, init] = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(input.toString()).pathname).toBe(`/api/v1/blobs/${expectedSiteID}/site:vitehub-blob`)
    expect(init).toMatchObject({ headers: { authorization: `Bearer ${expectedToken}` } })
  })

  it("uses one credential pair for deploy-scoped SDK and list requests", async () => {
    const encodedContext = Buffer.from(JSON.stringify({
      deployID: "deployid",
      siteID: "environment-site",
      token: "environment-token",
    })).toString("base64")
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", encodedContext)
    mockListPages({ first: { blobs: [], directories: [] } })

    await createDriver({
      deployScoped: true,
      driver: "netlify-blobs",
      name: "vitehub-blob",
      token: "explicit-token",
    }).list()

    expect(netlifyStores.getDeployStore).toHaveBeenCalledWith(expect.objectContaining({
      siteID: "environment-site",
      token: "explicit-token",
    }))
    const [input, init] = vi.mocked(fetch).mock.calls[0]!
    expect(new URL(input.toString()).pathname).toBe("/api/v1/blobs/environment-site/deploy:deployid:vitehub-blob")
    expect(init).toMatchObject({ headers: { authorization: "Bearer explicit-token" } })
  })

  it("decodes context and resumes cursors without Buffer", async () => {
    const context = btoa(JSON.stringify({ siteID: "environment-site", token: "environment-token" }))
    vi.stubGlobal("Buffer", undefined)
    vi.stubEnv("NETLIFY_BLOBS_CONTEXT", context)
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      json: async () => ({
        blobs: [
          { etag: "one", key: "one.txt" },
          { etag: "two", key: "two.txt" },
        ],
        directories: [],
      }),
    })))
    store.getMetadata.mockResolvedValue({ metadata: {} })

    const driver = createDriver({ driver: "netlify-blobs", name: "vitehub-blob" })
    const first = await driver.list({ limit: 1 })
    const second = await driver.list({ cursor: first.cursor, limit: 1 })

    expect(first.blobs.map(blob => blob.pathname)).toEqual(["one.txt"])
    expect(second.blobs.map(blob => blob.pathname)).toEqual(["two.txt"])
  })

  it("retries transient list failures", async () => {
    const cancel = vi.fn()
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ blobs: [], directories: [] }), { status: 200 })))

    await createDriver(options).list()

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([
    { status: 400, succeeds: false },
    { status: 404, succeeds: true },
  ])("cancels terminal $status list response bodies", async ({ status, succeeds }) => {
    const cancel = vi.fn()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }), { status })))

    const listing = createDriver(options).list()
    if (succeeds) await expect(listing).resolves.toMatchObject({ blobs: [] })
    else await expect(listing).rejects.toThrow(`Netlify Blobs list failed with status ${status}.`)

    expect(fetch).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("cancels the final list response after exhausting server-error retries", async () => {
    const cancels = Array.from({ length: 6 }, () => vi.fn())
    let responseIndex = 0
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel: cancels[responseIndex++] }), { status: 503 })))

    await expect(createDriver(options).list()).rejects.toThrow("Netlify Blobs list failed with status 503.")

    expect(fetch).toHaveBeenCalledTimes(6)
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce()
  })

  it("shares the retry budget across HTTP and network failures", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockRejectedValue(new Error("unreachable")))

    await expect(createDriver(options).list()).rejects.toThrow("unreachable")

    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it("supports explicit credentials and retries without process", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("process", undefined)
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ blobs: [], directories: [] }), { status: 200 })))

    try {
      const listing = createDriver(options).list()
      await vi.advanceTimersByTimeAsync(5_000)
      await listing
      expect(fetch).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not read protected Deno environment variables with explicit credentials", async () => {
    const getEnvironmentVariable = vi.fn(() => {
      throw new Error("Requires env access")
    })
    vi.stubGlobal("Deno", {
      env: {
        get: getEnvironmentVariable,
      },
    })
    mockListPages({ first: { blobs: [], directories: [] } })

    await expect(createDriver(options).list()).resolves.toMatchObject({ blobs: [] })
    expect(getEnvironmentVariable).not.toHaveBeenCalled()
  })

  it("buffers streams and records their actual byte length", async () => {
    store.set.mockResolvedValue({ etag: "etag" })
    const body = new Blob(["streamed"]).stream()

    const result = await createDriver(options).put("stream.txt", body)

    const [, normalizedBody, setOptions] = store.set.mock.calls[0]!
    expect(normalizedBody).toBeInstanceOf(ArrayBuffer)
    expect(new TextDecoder().decode(normalizedBody as ArrayBuffer)).toBe("streamed")
    expect(setOptions.metadata.__size).toBe(8)
    expect(result.size).toBe(8)
  })

  it("advances folder-only pages across folded cursors", async () => {
    mockListPages({
      first: { blobs: [{ etag: "skip", key: "skip.txt" }], directories: ["skipped/"], next_cursor: "page-2" },
      "page-2": { blobs: [], directories: ["folder-only/"], next_cursor: "page-3" },
      "page-3": { blobs: [{ etag: "keep", key: "keep.txt" }], directories: ["selected/"] },
    })
    store.getMetadata.mockResolvedValue({ metadata: {} })

    const driver = createDriver(options)
    const first = await driver.list({ folded: true, limit: 1 })
    const second = await driver.list({ cursor: first.cursor, folded: true, limit: 1 })

    expect(first.blobs.map(blob => blob.pathname)).toEqual(["skip.txt"])
    expect(first.folders).toEqual(["skipped/", "folder-only/"])
    expect(second.blobs.map(blob => blob.pathname)).toEqual(["keep.txt"])
    expect(second.folders).toEqual(["selected/"])
    expect(fetch).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchParams: expect.any(URLSearchParams) }),
      expect.objectContaining({ headers: { authorization: "Bearer secret" } }),
    )
    expect(new URL(vi.mocked(fetch).mock.calls.at(-1)![0].toString()).searchParams.get("cursor")).toBe("page-3")
  })

  it("does not repeat folded directories across repeated page resumes", async () => {
    mockListPages({
      first: {
        blobs: [
          { etag: "one", key: "one.txt" },
          { etag: "two", key: "two.txt" },
          { etag: "three", key: "three.txt" },
        ],
        directories: ["nested/"],
      },
    })
    store.getMetadata.mockResolvedValue({ metadata: {} })

    const driver = createDriver(options)
    const first = await driver.list({ folded: true, limit: 1 })
    const second = await driver.list({ cursor: first.cursor, folded: true, limit: 1 })
    const third = await driver.list({ cursor: second.cursor, folded: true, limit: 1 })

    expect(first.folders).toEqual(["nested/"])
    expect(second.folders).toEqual([])
    expect(third.folders).toEqual([])
    expect(third.blobs.map(blob => blob.pathname)).toEqual(["three.txt"])
  })

  it("bounds concurrent metadata lookups and preserves listing order", async () => {
    const blobs = Array.from({ length: 40 }, (_, index) => ({ etag: `etag-${index}`, key: `${index}.txt` }))
    mockListPages({ first: { blobs, directories: [] } })
    let active = 0
    let maximumActive = 0
    store.getMetadata.mockImplementation(async () => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active--
      return { metadata: {} }
    })

    const result = await createDriver(options).list()

    expect(maximumActive).toBe(16)
    expect(result.blobs.map(blob => blob.pathname)).toEqual(blobs.map(blob => blob.key))
  })
})
