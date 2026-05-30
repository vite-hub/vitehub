import { afterEach, describe, expect, it, vi } from "vitest"

import { canResolveModule, clearResolveCache, tryResolveModule } from "../src/internal/shared/module-resolve.ts"

afterEach(() => {
  vi.unstubAllGlobals()
  clearResolveCache()
})

describe("module resolve", () => {
  it("returns false instead of throwing when process is unavailable", () => {
    vi.stubGlobal("process", undefined)

    expect(canResolveModule("@vite-hub/does-not-exist")).toBe(false)
  })

  it("returns a missing-module result instead of throwing when process is unavailable", () => {
    vi.stubGlobal("process", undefined)

    expect(tryResolveModule("@vite-hub/does-not-exist")).toEqual({
      ok: false,
      error: 'Unable to resolve module "@vite-hub/does-not-exist" without explicit resolution paths',
    })
  })
})
