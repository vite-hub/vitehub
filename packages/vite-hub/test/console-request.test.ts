import { afterEach, describe, expect, it, vi } from "vitest"

import { requestConsole } from "../src/console/runtime/client/request.ts"

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
    expect(fetch).toHaveBeenCalledWith("/api/_vitehub/console/sections", { signal: undefined })
  })
})
