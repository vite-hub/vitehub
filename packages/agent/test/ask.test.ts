import { runInNewContext } from "node:vm"

import { describe, expect, it, vi } from "vitest"

import { ask } from "@vite-hub/gateways"

const invalidKeys: unknown[] = [
  "", " \t\n", undefined, null, 0, false, 1n, Symbol("key"),
  Object("key"), runInNewContext("Object('foreign')"),
  { [Symbol.toStringTag]: "String", toString: () => "key" },
  () => "key",
]

describe("ask.each keys", () => {
  it("keeps primitive string keys and question order in a null-prototype map", () => {
    const foreignKey: string = runInNewContext("'foreign'")
    const keys = ["__proto__", "constructor", " padded ", foreignKey]
    const question = vi.fn((key: string) => ask.if(key))

    const questions = ask.each(keys, { key: key => key, question })

    expect(Object.getPrototypeOf(questions)).toBeNull()
    expect(Object.keys(questions)).toEqual(keys)
    expect(question.mock.calls.map(([key]) => key)).toEqual(keys)
    for (const [index, key] of keys.entries()) {
      expect(questions[key]).toBe(question.mock.results[index]!.value)
    }
  })

  it.each(invalidKeys)("rejects invalid key %s before building a question", (key) => {
    const question = vi.fn(() => ask.if("Continue?"))

    // SAFETY: A JavaScript callback can return a value outside the declared string contract.
    expect(() => ask.each([key], { key: item => item as string, question }))
      .toThrow(new TypeError("ask.each keys must be non-empty strings"))
    expect(question).not.toHaveBeenCalled()
  })

  it("rejects proxies without reading or coercing their properties", () => {
    const get = vi.fn(() => { throw new Error("Key property read") })
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const question = vi.fn(() => ask.if("Continue?"))

    for (const key of [new Proxy({}, { get }), revoked.proxy]) {
      // SAFETY: These object keys test calls from JavaScript outside the string contract.
      expect(() => ask.each([key], { key: item => item as string, question }))
        .toThrow(new TypeError("ask.each keys must be non-empty strings"))
    }
    expect(get).not.toHaveBeenCalled()
    expect(question).not.toHaveBeenCalled()
  })

  it("rejects a duplicate before building its question", () => {
    const question = vi.fn(() => ask.if("Continue?"))

    expect(() => ask.each(["__proto__", "__proto__"], { key: key => key, question }))
      .toThrow('ask.each produced duplicate key "__proto__"')
    expect(question).toHaveBeenCalledTimes(1)
  })
})
