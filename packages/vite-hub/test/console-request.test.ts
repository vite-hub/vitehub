import { afterEach, describe, expect, it, vi } from "vitest"

import { requestConsole } from "../src/console/runtime/client/request.ts"
import { createConsoleSectionLoader } from "../src/console/runtime/client/sections.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Console requests", () => {
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
})
