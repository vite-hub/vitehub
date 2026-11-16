import { afterEach, describe, expect, it, vi } from "vitest"

import { canResolveModule, clearResolveCache, tryResolveModule } from "../../src/task/internal/shared/module-resolve.ts"

afterEach(() => {
  vi.unstubAllGlobals()
  clearResolveCache()
})

describe("module resolve", () => {
  it("returns false instead of throwing when process is unavailable", () => {
    vi.stubGlobal("process", undefined)

    expect(canResolveModule("@vite-hub/does-not-exist")).toBe(false)
  })

  it("returns undefined instead of throwing when process is unavailable", () => {
    vi.stubGlobal("process", undefined)

    expect(tryResolveModule("@vite-hub/does-not-exist")).toBeUndefined()
  })
})
