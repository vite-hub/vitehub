import { describe, expect, it } from "vitest"
import vm from "node:vm"
import { defineAgent } from "../src/index.ts"

describe("cross realm agent options", () => {
  it("clones nested cross realm records instead of preserving the source", () => {
    const nested = vm.runInNewContext("({ answer: 42 })") as { answer: number }
    const configure = (options: { nested: { answer: number } }) => defineAgent({ driver: "codex", data: options.nested })
    const preset = defineAgent({ options: { nested }, configure })
    const inherited = defineAgent({ extends: preset })
    expect(inherited.options.nested).not.toBe(nested)
    expect(inherited.options.nested.answer).toBe(42)
    inherited.options.nested.answer = 7
    expect(nested.answer).toBe(42)
  })
})

it("snapshots cross realm built-ins while preserving their data", () => {
  const values = vm.runInNewContext(`(() => {
    const buffer = new ArrayBuffer(4)
    new Uint8Array(buffer).set([1, 2, 3, 4])
    const shared = new SharedArrayBuffer(2)
    new Uint8Array(shared).set([5, 6])
    return {
      array: [1, 2],
      date: new Date("2025-01-01T00:00:00.000Z"),
      map: new Map([["key", { value: 1 }]]),
      set: new Set(["entry"]),
      regexp: /pattern/gi,
      buffer,
      bytes: new Uint8Array(buffer, 1, 2),
      data: new DataView(buffer, 0, 2),
      shared,
      sharedBytes: new Uint8Array(shared),
    }
  })()`) as {
    array: number[]
    date: Date
    map: Map<string, { value: number }>
    set: Set<string>
    regexp: RegExp
    buffer: ArrayBuffer
    bytes: Uint8Array
    data: DataView
    shared: SharedArrayBuffer
    sharedBytes: Uint8Array
  }
  const configureCalls: typeof values[] = []
  const preset = defineAgent({
    options: { values },
    configure: (options: { values: typeof values }) => {
      configureCalls.push(options.values)
      return defineAgent({ driver: "codex" })
    },
  })
  const inherited = defineAgent({ extends: preset })
  for (const clone of [preset.options.values, inherited.options.values, ...configureCalls]) {
    expect(clone).not.toBe(values)
    expect(clone.array).not.toBe(values.array)
    expect(clone.array).toEqual([1, 2])
    expect(clone.date).not.toBe(values.date)
    expect(clone.date.toISOString()).toBe(values.date.toISOString())
    expect(clone.map).not.toBe(values.map)
    expect(clone.map.get("key")).toEqual({ value: 1 })
    expect(clone.set).not.toBe(values.set)
    expect([...clone.set]).toEqual(["entry"])
    expect(clone.regexp).not.toBe(values.regexp)
    expect(clone.regexp.source).toBe("pattern")
    expect(clone.buffer).not.toBe(values.buffer)
    expect([...new Uint8Array(clone.buffer)]).toEqual([1, 2, 3, 4])
    expect(clone.bytes).not.toBe(values.bytes)
    expect([...clone.bytes]).toEqual([2, 3])
    expect(clone.bytes.buffer).toBe(clone.buffer)
    expect(clone.data).not.toBe(values.data)
    expect(clone.data.buffer).toBe(clone.buffer)
    expect(clone.shared).not.toBe(values.shared)
    expect([...new Uint8Array(clone.shared)]).toEqual([5, 6])
    expect(clone.sharedBytes).not.toBe(values.sharedBytes)
    expect([...clone.sharedBytes]).toEqual([5, 6])
    expect(clone.sharedBytes.buffer).toBe(clone.shared)
  }
})

it("keeps custom Buffer subclasses atomic and clones native foreign Buffers", () => {
  class CustomBuffer extends globalThis.Buffer {
    marker = true

    constructor(bytes: Uint8Array) {
      const buffer = super(bytes)
      // Node's Buffer constructor returns a Buffer instance. Restore the
      // subclass prototype so this test models application-defined subclasses.
      return Object.setPrototypeOf(buffer, new.target.prototype)
    }
  }
  const custom = new CustomBuffer([1, 2])
  const foreign = vm.runInNewContext("Buffer.from([3, 4])", { Buffer }) as Buffer
  const preset = defineAgent({
    options: { custom, foreign },
    configure: (options: { custom: Buffer; foreign: Buffer }) => defineAgent({ driver: "codex", data: options }),
  })
  const inherited = defineAgent({ extends: preset })
  expect(inherited.options.custom).toBe(custom)
  expect(inherited.options.foreign).not.toBe(foreign)
  expect([...inherited.options.foreign]).toEqual([3, 4])
  inherited.options.foreign[0] = 9
  expect(foreign[0]).toBe(3)
})

it("keeps a custom Buffer subclass named Buffer atomic", () => {
  class Buffer extends globalThis.Buffer {
    marker = true

    constructor(bytes: Uint8Array) {
      const buffer = super(bytes)
      return Object.setPrototypeOf(buffer, new.target.prototype)
    }
  }
  const custom = new Buffer(new Uint8Array([1, 2]))
  const preset = defineAgent({
    options: { custom },
    configure: (options: { custom: Buffer }) => defineAgent({ driver: "codex", data: options }),
  })
  const inherited = defineAgent({ extends: preset })
  expect(inherited.options.custom).toBe(custom)
})

it("does not trust a backing store's Symbol.toStringTag", () => {
  const buffer = new ArrayBuffer(2)
  new Uint8Array(buffer).set([1, 2])
  Object.defineProperty(buffer, Symbol.toStringTag, { value: "SharedArrayBuffer" })
  const preset = defineAgent({
    options: { bytes: new Uint8Array(buffer) },
    configure: (options: { bytes: Uint8Array }) => defineAgent({ driver: "codex", data: options }),
  })
  const inherited = defineAgent({ extends: preset })
  expect([...inherited.options.bytes]).toEqual([1, 2])
  inherited.options.bytes[0] = 9
  expect(new Uint8Array(buffer)[0]).toBe(1)
})
