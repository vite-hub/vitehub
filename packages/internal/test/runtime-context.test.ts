import { describe, expect, it, vi } from "vitest"

import { isResolvable, resolveRuntimeContext, resolveRuntimeValue } from "../src/runtime/context.ts"

describe("runtime context helpers", () => {
  it("resolves static, function, and object values against a runtime context", async () => {
    const context = {
      memo: vi.fn(),
      runtime: "vite",
      runtimeConfig: { region: "local" },
      waitUntil: vi.fn(),
    }

    await expect(resolveRuntimeValue("static", context)).resolves.toBe("static")
    await expect(resolveRuntimeValue(ctx => ctx.runtimeConfig.region, context)).resolves.toBe("local")
    await expect(resolveRuntimeValue({ resolve: ctx => ctx.runtime }, context)).resolves.toBe("vite")
  })

  it("detects object resolvers", () => {
    expect(isResolvable({ resolve: () => "ok" })).toBe(true)
    expect(isResolvable(() => "ok")).toBe(false)
    expect(isResolvable("ok")).toBe(false)
  })

  it("normalizes missing runtime config to an object", () => {
    const context = resolveRuntimeContext({
      memo: vi.fn(),
      runtime: "unknown",
      waitUntil: vi.fn(),
    })

    expect(context.runtimeConfig).toEqual({})
  })
})
