import { describe, expect, it } from "vitest"

import { hasRuntimeType } from "../src/internal/runtime-type.ts"

describe("Runtime representation guards", () => {
  it("distinguishes callable and object representations", () => {
    expect(hasRuntimeType(null, "object")).toBe(true)
    expect(hasRuntimeType({}, "object")).toBe(true)
    expect(hasRuntimeType(() => undefined, "function")).toBe(true)
    const spoofed = { [Symbol.toStringTag]: "Function" }
    expect(hasRuntimeType(spoofed, "function")).toBe(false)
    expect(hasRuntimeType(spoofed, "object")).toBe(true)
    const hostile = new Proxy({}, { get() { throw new Error("blocked property") } })
    expect(hasRuntimeType(hostile, "object")).toBe(true)
    expect(hasRuntimeType(hostile, "function")).toBe(false)
  })
})
