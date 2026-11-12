import { describe, expect, it, vi } from "vitest"

import { cachedSource } from "../src/server.ts"

// Nitro cache fails to load once, as an import can fail during a development rebuild.
const nitroCache = vi.hoisted(() => ({ failures: 1 }))

vi.mock("nitro/cache", () => {
  if (nitroCache.failures > 0) {
    nitroCache.failures--
    throw new Error("transient Nitro cache import failure")
  }
  return { defineCachedFunction: (reader: (...args: unknown[]) => unknown) => reader }
})

describe("cached Source readers", () => {
  it("loads Nitro cache again on the next get after a failed load", async () => {
    const source = cachedSource({
      async get(key: string) {
        return key
      },
    }, { name: "retry" })

    await expect(source.get("news")).rejects.toThrow()
    await expect(source.get("news")).resolves.toBe("news")
  })
})
