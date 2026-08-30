import { afterEach, describe, expect, it, vi } from "vitest"

import { appendUniqueConsoleKeys, loadConsoleKVPages, requestConsole } from "../src/console/runtime/client/request.ts"
import { createConsoleSectionLoader, loadConsoleNavigation } from "../src/console/runtime/client/sections.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Console requests", () => {
  it("deduplicates keys repeated across provider pages", () => {
    expect(appendUniqueConsoleKeys(["first", "repeated"], ["repeated", "last"]))
      .toEqual(["first", "repeated", "last"])
  })

  it("supports requests without query or signal options", async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ sections: ["kv"] }),
      ok: true,
    })
    vi.stubGlobal("fetch", fetch)

    await expect(requestConsole("/api/_vitehub/console/sections"))
      .resolves.toEqual({ sections: ["kv"] })
    expect(fetch).toHaveBeenCalledWith("/api/_vitehub/console/sections", { method: "GET", signal: undefined })
  })

  it("sends read-only actions as JSON POST requests", async () => {
    const fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve({ found: true }), ok: true })
    vi.stubGlobal("fetch", fetch)

    await expect(requestConsole("/api/_vitehub/console/kv", {
      body: { key: "x".repeat(24_576), store: "default" },
      method: "POST",
    })).resolves.toEqual({ found: true })
    expect(fetch).toHaveBeenCalledWith("/api/_vitehub/console/kv", {
      body: expect.stringContaining('"store":"default"'),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: undefined,
    })
  })

  it("loads every KV page using the configured base and stops repeated cursors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ cursor: "next", keys: ["first"] }), ok: true })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ cursor: "next", keys: ["second"] }), ok: true })
    vi.stubGlobal("fetch", fetch)

    await expect(loadConsoleKVPages("/host/api/_vitehub/console/kv", "cache", new AbortController().signal))
      .resolves.toEqual({
        pages: [
          { cursor: "next", keys: ["first"] },
          { cursor: "next", keys: ["second"] },
        ],
        truncated: false,
      })
    expect(fetch).toHaveBeenNthCalledWith(1, "/host/api/_vitehub/console/kv?store=cache", expect.any(Object))
    expect(fetch).toHaveBeenNthCalledWith(2, "/host/api/_vitehub/console/kv?cursor=next&store=cache", expect.any(Object))
  })

  it("continues through empty KV pages within a bounded search budget", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ cursor: "next", keys: [] }), ok: true })
      .mockResolvedValueOnce({ json: () => Promise.resolve({ cursor: "last", keys: ["matching"] }), ok: true })
    vi.stubGlobal("fetch", fetch)

    await expect(loadConsoleKVPages(
      "/api/_vitehub/console/kv",
      "cache",
      new AbortController().signal,
      undefined,
      { limit: 50, maxPages: 2, prefix: "match" },
    )).resolves.toEqual({
      pages: [
        { cursor: "next", keys: [] },
        { cursor: "last", keys: ["matching"] },
      ],
      truncated: true,
    })
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/_vitehub/console/kv?cursor=next&limit=50&prefix=match&store=cache",
      expect.any(Object),
    )
  })

  it("retries section discovery after a failed request and caches a successful response", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValue({
        json: () => Promise.resolve({ sections: ["kv"] }),
        ok: true,
      })
    vi.stubGlobal("fetch", fetch)
    const loadSections = createConsoleSectionLoader("/api/_vitehub/console/sections")

    await expect(loadSections()).resolves.toBeUndefined()
    await expect(loadSections()).resolves.toEqual(["kv"])
    await expect(loadSections()).resolves.toEqual(["kv"])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("loads the project name and enabled sections as one navigation response", async () => {
    const fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ projectName: " console-host ", sections: ["kv", "unknown"] }),
      ok: true,
    })
    vi.stubGlobal("fetch", fetch)

    await expect(loadConsoleNavigation("/api/_vitehub/console/navigation-test")).resolves.toEqual({
      projectName: "console-host",
      sections: ["kv"],
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
