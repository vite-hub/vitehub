import { describe, expect, it, vi } from "vitest"

import { backoffDelay, randomUUID } from "../src/browser-environment.ts"

describe("backoffDelay", () => {
  it("doubles from 1 s to 30 s with jitter on the upper half", () => {
    expect(backoffDelay(0, 0)).toBe(500)
    expect(backoffDelay(0, 1)).toBe(1000)
    expect(backoffDelay(3, 0.5)).toBe(6000)
    expect(backoffDelay(20, 1)).toBe(30_000)
  })
})

describe("randomUUID", () => {
  it("makes a version 4 UUID also where crypto.randomUUID() is missing, as on a LAN address over HTTP", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(randomUUID()).toMatch(uuid)
    const real = globalThis.crypto
    vi.stubGlobal("crypto", { getRandomValues: (array: Uint8Array<ArrayBuffer>) => real.getRandomValues(array) })
    try {
      const keys = new Set(Array.from({ length: 100 }, () => randomUUID()))
      expect(keys.size).toBe(100)
      for (const key of keys) expect(key).toMatch(uuid)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
