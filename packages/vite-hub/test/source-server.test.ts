import { beforeEach, describe, expect, it, vi } from "vitest"

const defineCachedFunction = vi.fn((reader: (...args: unknown[]) => unknown) => reader)

vi.mock("nitro/cache", () => ({ defineCachedFunction }))

const { defineSource } = await import("../src/source/server.ts")

describe("server Source readers", () => {
  beforeEach(() => {
    defineCachedFunction.mockClear()
  })

  it("wraps keyed readers with the configured Nitro cache", async () => {
    const reader = {
      cache: { maxAge: 60 },
      async get(key: string) {
        return key.toUpperCase()
      },
    }

    const source = defineSource(reader)

    await expect(source.get("news")).resolves.toBe("NEWS")
    expect(defineCachedFunction).toHaveBeenCalledWith(expect.any(Function), {
      maxAge: 60,
      swr: false,
    })
  })

  it("leaves readers without cache settings unchanged", () => {
    const reader = {
      async get(key: string) {
        return key
      },
    }

    expect(defineSource(reader)).toBe(reader)
    expect(defineCachedFunction).not.toHaveBeenCalled()
  })

  it("leaves readers with caching disabled unchanged", () => {
    const reader = {
      cache: false as const,
      async get(key: string) {
        return key
      },
    }

    expect(defineSource(reader)).toBe(reader)
    expect(defineCachedFunction).not.toHaveBeenCalled()
  })
})
