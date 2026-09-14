import { describe, expect, it } from "vitest"

import { sameInlineInvoker } from "../src/internal/inline-invoker.ts"

describe("inline invoker identity", () => {
  it("compares reconstructed Date metadata by timestamp", () => {
    const invoker = (timestamp: number) => ({ id: "user", meta: { joinedAt: new Date(timestamp) } })
    expect(sameInlineInvoker(invoker(1000), invoker(1000))).toBe(true)
    expect(sameInlineInvoker(invoker(1000), invoker(2000))).toBe(false)
    expect(sameInlineInvoker(invoker(NaN), invoker(NaN))).toBe(true)
    expect(sameInlineInvoker(invoker(NaN), invoker(1000))).toBe(false)
  })

  it("preserves Date metadata and does not call overridden timestamp methods", () => {
    const getTime = () => { throw new Error("Unexpected timestamp override") }
    const left = Object.assign(new Date(1000), { getTime, role: "reader" })
    const right = Object.assign(new Date(1000), { getTime, role: "reader" })
    expect(sameInlineInvoker({ meta: left }, { meta: right })).toBe(true)
    right.role = "writer"
    expect(sameInlineInvoker({ meta: left }, { meta: right })).toBe(false)
    expect(sameInlineInvoker(new Date(1000), Object.create(Date.prototype))).toBe(false)
  })

  it("compares reconstructed built-in metadata and distinguishes changed values", () => {
    const factories = [
      (value: number) => new Map([["permission", { value }]]),
      (value: number) => new Set([{ value }]),
      (value: number) => new RegExp(`role${value}`, "gi"),
      (value: number) => new URL(`https://example.com/${value}`),
      (value: number) => new Uint16Array([value]),
      (value: number) => new DataView(new Uint8Array([value]).buffer),
      (value: number) => new Uint8Array([value]).buffer,
    ]
    for (const create of factories) {
      expect(sameInlineInvoker({ meta: create(1) }, { meta: create(1) })).toBe(true)
      expect(sameInlineInvoker({ meta: create(1) }, { meta: create(2) })).toBe(false)
    }
    expect(sameInlineInvoker(new ArrayBuffer(0), Object.create(ArrayBuffer.prototype))).toBe(false)
    expect(sameInlineInvoker(Object.assign(new Set([1]), { role: "reader" }), Object.assign(new Set([1]), { role: "writer" }))).toBe(false)
    expect(sameInlineInvoker(/role/g, /role/i)).toBe(false)
    expect(sameInlineInvoker(new Uint8Array([1]), new Int8Array([1]))).toBe(false)
  })

  it("handles cyclic collection metadata without invoking instance methods", () => {
    const left = new Map<unknown, unknown>()
    const right = new Map<unknown, unknown>()
    left.set("self", left)
    right.set("self", right)
    const entries = () => { throw new Error("Unexpected entries override") }
    Object.assign(left, { entries })
    Object.assign(right, { entries })
    expect(sameInlineInvoker(left, right)).toBe(true)
    right.set("permission", "writer")
    expect(sameInlineInvoker(left, right)).toBe(false)
  })

  it("compares bigint metadata without coercion", () => {
    expect(sameInlineInvoker({ meta: { value: 1n } }, { meta: { value: 1n } })).toBe(true)
    expect(sameInlineInvoker({ meta: { value: 1n } }, { meta: { value: "1" } })).toBe(false)
  })

  it("compares reconstructed cyclic metadata and retains differing values", () => {
    const left: Record<string, unknown> = { role: "reader" }
    const right: Record<string, unknown> = { role: "reader" }
    left.self = left
    right.self = right
    expect(sameInlineInvoker({ meta: left }, { meta: right })).toBe(true)
    right.role = "writer"
    expect(sameInlineInvoker({ meta: left }, { meta: right })).toBe(false)
  })

  it("distinguishes metadata that JSON omits", () => {
    for (const value of [undefined, () => {}, Symbol("value")]) {
      expect(sameInlineInvoker({ meta: {} }, { meta: { value } })).toBe(false)
    }
    expect(sameInlineInvoker({ value: -0 }, { value: 0 })).toBe(false)
    expect(sameInlineInvoker({ value: NaN }, { value: null })).toBe(false)
  })

  it("compares Proxy descriptors without reading serialization traps", () => {
    const left = new Proxy({ value: 1 }, { get: () => undefined })
    const right = new Proxy({ value: 2 }, { get: () => undefined })
    expect(JSON.stringify(left)).toBe(JSON.stringify(right))
    expect(sameInlineInvoker({ meta: left }, { meta: right })).toBe(false)
  })

  it("does not invoke metadata getters or toJSON", () => {
    const value = { get role() { throw new Error("Unexpected getter") } }
    expect(sameInlineInvoker({ meta: value }, { meta: { role: "reader" } })).toBe(false)
    const toJSON = () => { throw new Error("Unexpected serialization") }
    expect(sameInlineInvoker({ value: 1, toJSON }, { value: 2, toJSON })).toBe(false)
  })
})
