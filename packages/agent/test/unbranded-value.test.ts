import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { isUnbrandedValue } from "../src/internal/runtime-type.ts"

describe("isUnbrandedValue", () => {
  it("accepts primitives, object literals, and null-prototype records", () => {
    for (const value of [undefined, null, 0, "2026-01-01T00:00:00.000Z", true, 1n, Symbol("value"), {}, { nested: { a: 1 } }, Object.create(null)]) {
      expect(isUnbrandedValue(value)).toBe(true)
    }
  })

  it("leaves built-in objects, class instances, and foreign objects to the brand checks", () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    for (const value of [new Date(), new Map(), new Set(), /a/, new ArrayBuffer(1), Object(1), [], () => {}, new (class Record {})(), runInNewContext("({})"), runInNewContext("new Date()"), proxy]) {
      expect(isUnbrandedValue(value)).toBe(false)
    }
  })
})
