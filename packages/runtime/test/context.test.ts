import { describe, expect, expectTypeOf, it, vi } from "vitest"

import { createRuntimeContext } from "../src/index.ts"

describe("createRuntimeContext", () => {
  it("creates isolated memo values for each operation", () => {
    const first = createRuntimeContext({ runtime: "test" })
    const second = createRuntimeContext({ runtime: "test" })
    const create = vi.fn(() => ({ id: 1 }))
    const value = first.memo("value", create)
    expect(first.memo("value", create)).toBe(value)
    expect(create).toHaveBeenCalledTimes(1)
    expect(second.memo("value", create)).not.toBe(value)
    expect(first.capabilities).not.toBe(second.capabilities)
    expect(first.runtimeConfig).not.toBe(second.runtimeConfig)
    expectTypeOf(first.runtime).toEqualTypeOf<"test">()
    expectTypeOf(value).toEqualTypeOf<{ id: number }>()
  })

  it("preserves supplied resources and memo, including config inference", () => {
    const memo = createRuntimeContext({ runtime: "test" }).memo
    const input = { runtime: "test", runtimeConfig: { region: "local" }, capabilities: { db: { name: "db" } }, memo }
    const context = createRuntimeContext(input)
    expect(context.runtimeConfig).toBe(input.runtimeConfig)
    expect(context.capabilities).toBe(input.capabilities)
    expect(context.memo).toBe(memo)
    expectTypeOf(context.runtimeConfig.region).toEqualTypeOf<string>()
  })

  it("caches undefined and retries a failed memo creator", () => {
    const context = createRuntimeContext({ runtime: "test" })
    const empty = vi.fn(() => undefined)
    context.memo("empty", empty)
    context.memo("empty", empty)
    expect(empty).toHaveBeenCalledTimes(1)
    expect(() => context.memo("retry", () => { throw new Error("failed") })).toThrow("failed")
    expect(context.memo("retry", () => "ok")).toBe("ok")
  })

  it("drains nested tasks without a host lifetime API and reports failures", async () => {
    const context = createRuntimeContext({ runtime: "test" })
    const complete = vi.fn()
    context.waitUntil(Promise.resolve().then(() => {
      context.waitUntil(Promise.resolve().then(complete))
      throw new Error("background failure")
    }))
    await expect(context.flushWaitUntil()).rejects.toThrow("background failure")
    expect(complete).toHaveBeenCalledTimes(1)
    await expect(context.flushWaitUntil()).resolves.toBeUndefined()
  })

  it("keeps the host receiver and can drain after forwarding fails", async () => {
    const input = {
      runtime: "test",
      waitUntil(task: Promise<unknown>) {
        expect(this).toBe(input)
        expect(task).toBe(work)
        throw new Error("host closed")
      },
    }
    const work = Promise.reject(new Error("task failed"))
    const context = createRuntimeContext(input)
    expect(() => context.waitUntil(work)).toThrow("host closed")
    await expect(context.flushWaitUntil()).rejects.toThrow("task failed")
  })
})
