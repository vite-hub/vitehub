import { describe, expect, it } from "vitest"

import { agentResultKind } from "../src/agent-output.ts"
import { hasRuntimeType, runtimeType } from "../src/internal/runtime-type.ts"

describe("Agent runtime representation guards", () => {
  it("preserves JavaScript representation categories", () => {
    expect(hasRuntimeType(undefined, "undefined")).toBe(true)
    expect(hasRuntimeType(null, "object")).toBe(true)
    expect(hasRuntimeType({}, "object")).toBe(true)
    expect(hasRuntimeType(() => undefined, "function")).toBe(true)
    expect(hasRuntimeType(class {}, "function")).toBe(true)
    expect(hasRuntimeType("value", "string")).toBe(true)
    expect(hasRuntimeType(1, "number")).toBe(true)
    expect(hasRuntimeType(true, "boolean")).toBe(true)
    expect(hasRuntimeType(1n, "bigint")).toBe(true)
    expect(hasRuntimeType(Symbol("value"), "symbol")).toBe(true)
  })

  it("does not treat a spoofed function tag as callable", () => {
    const spoofed = { [Symbol.toStringTag]: "Function" }
    expect(hasRuntimeType(spoofed, "function")).toBe(false)
    expect(hasRuntimeType(spoofed, "object")).toBe(true)
    expect(runtimeType(spoofed)).toBe("object")
  })

  it("classifies hostile proxies without reading their properties", () => {
    const hostile = new Proxy({}, { get() { throw new Error("blocked property") } })
    expect(hasRuntimeType(hostile, "object")).toBe(true)
    expect(hasRuntimeType(hostile, "function")).toBe(false)
    expect(runtimeType(hostile)).toBe("object")
    expect(agentResultKind(hostile)).toBe("object")
  })
})
