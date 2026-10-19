import vm from "node:vm"

import { describe, expect, it, vi } from "vitest"

import { inspectKVValue } from "../src/runtime/inspect-value.ts"

describe("KV inspection values", () => {
  it("returns JSON data independently from the stored value", () => {
    const shared = { count: 9007199254740993n }
    const value = { first: shared, second: shared }
    const inspected = inspectKVValue(value)
    expect(inspected).toEqual({ type: "object", value: { first: { count: "9007199254740993" }, second: { count: "9007199254740993" } } })
    expect(inspected?.value).not.toBe(value)
    expect(inspectKVValue(null)).toEqual({ type: "null", value: null })
    expect(inspectKVValue(new Uint8Array([0, 127, 255]))).toEqual({ encoding: "base64", type: "bytes", value: "AH//" })
  })

  it("recognizes byte arrays from another JavaScript realm", () => {
    const value = vm.runInNewContext("new Uint8Array([0, 127, 255])")
    expect(value).not.toBeInstanceOf(Uint8Array)
    expect(inspectKVValue(value)).toEqual({ encoding: "base64", type: "bytes", value: "AH//" })
  })

  it.each(["byteLength", "length"] as const)("rejects hostile own %s accessors without running them", key => {
    const value = new Uint8Array([0, 127, 255])
    const getter = vi.fn()
      .mockReturnValueOnce(3)
      .mockImplementation(() => { throw new Error("unstable byte metadata") })
    Object.defineProperty(value, key, { get: getter })

    expect(inspectKVValue(value)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
  })

  it("uses native byte iteration without running a custom iterator", () => {
    const value = new Uint8Array([0, 127, 255])
    const iterator = vi.fn(() => { throw new Error("hostile iterator") })
    Object.defineProperty(value, Symbol.iterator, { get: iterator })

    expect(inspectKVValue(value)).toEqual({ encoding: "base64", type: "bytes", value: "AH//" })
    expect(iterator).not.toHaveBeenCalled()
  })

  it("rejects detached byte arrays instead of reporting empty data", () => {
    const value = new Uint8Array([0, 127, 255])
    structuredClone(value, { transfer: [value.buffer] })

    expect(inspectKVValue(value)).toBeUndefined()
  })

  it("rejects spoofed non-byte views and does not invoke Symbol.toStringTag", () => {
    const typed = new Uint16Array([0x1234])
    Object.defineProperty(typed, Symbol.toStringTag, { get: () => { throw new Error("should not run") } })
    const dataView = new DataView(new ArrayBuffer(2))
    Object.defineProperty(dataView, Symbol.toStringTag, { value: "Uint8Array" })
    expect(inspectKVValue(typed)).toBeUndefined()
    expect(inspectKVValue(dataView)).toBeUndefined()
  })

  it("rejects object behavior without running getters or toJSON", () => {
    const getter = vi.fn(() => "secret")
    const toJSON = vi.fn(() => "secret")
    expect(inspectKVValue(Object.defineProperty({}, "secret", { enumerable: true, get: getter }))).toBeUndefined()
    expect(inspectKVValue({ toJSON })).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
  })

  it("rejects values JSON would lose while allowing shared references", () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const sparse = ["first", "second", "third"]
    Reflect.deleteProperty(sparse, "1")
    for (const value of [cyclic, undefined, -0, Number.POSITIVE_INFINITY, sparse, { nested: new Uint8Array([1]) }]) {
      expect(inspectKVValue(value)).toBeUndefined()
    }
    const shared = { entry: "kept" }
    expect(inspectKVValue([shared, shared])).toEqual({ type: "array", value: [{ entry: "kept" }, { entry: "kept" }] })
  })
})
