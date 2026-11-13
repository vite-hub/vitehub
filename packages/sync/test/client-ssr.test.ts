import { describe, expect, it, vi } from "vitest"

import { clearSync, createSync } from "../src/client.ts"

describe("createSync on the server", () => {
  it("makes no request, starts no timer, and has no rows", async () => {
    expect("window" in globalThis).toBe(false)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const timer = vi.spyOn(globalThis, "setTimeout")
    const store = createSync("todos", { fetch, interval: 1000 })
    await store.refresh()
    expect(store.getState()).toEqual({ rows: [], status: "idle", error: null, queued: 0, failures: [], persisted: false })
    expect(store.get("a")).toBeUndefined()
    expect(() => store.insert({ title: "Milk" })).toThrow("browser")
    await clearSync()
    expect(fetch).not.toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
    store.destroy()
    timer.mockRestore()
  })
})
