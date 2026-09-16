import { describe, expect, it, vi } from "vitest"
import { defineAgent } from "../src/index.ts"

describe("configured option graphs", () => {
  it.each([false, true])("keeps shared defaults separate from one overridden occurrence (reverse keys: %s)", reverse => {
    const shared = { value: 1 }
    const defaults = reverse
      ? { right: shared, left: shared, untouched: shared }
      : { left: shared, right: shared, untouched: shared }
    const configure = vi.fn((_options: typeof defaults) => defineAgent({ driver: "codex" }))
    const preset = defineAgent({ options: defaults, configure })
    const extended = defineAgent({ extends: preset, options: { left: { value: 2 }, right: undefined } })
    for (const options of [extended.options, configure.mock.calls.at(-1)![0]]) {
      expect(options.left.value).toBe(2)
      expect(options.right.value).toBe(1)
      expect(options.untouched.value).toBe(1)
      expect(options.right).toBe(options.untouched)
      expect(options.left).not.toBe(options.right)
    }
    expect(shared.value).toBe(1)
    expect(preset.options.left.value).toBe(1)
  })

  it("preserves cycles through default records and containers in separate override graphs", () => {
    interface Node { value: number, self?: Node, entries: Node[], map: Map<string, Node>, set: Set<Node> }
    const shared: Node = { value: 1, entries: [], map: new Map(), set: new Set() }
    shared.self = shared
    shared.entries.push(shared)
    shared.map.set("self", shared)
    shared.set.add(shared)
    const preset = defineAgent({ options: { left: shared, right: shared }, configure: () => defineAgent({ driver: "codex" }) })
    const extended = defineAgent({ extends: preset, options: { left: { value: 2 } } })
    expect(extended.options.left.value).toBe(2)
    expect(extended.options.right.value).toBe(1)
    for (const options of [extended.options.left, extended.options.right]) {
      expect(options.self).toBe(options)
      expect(options.entries[0]).toBe(options)
      expect(options.map.get("self")).toBe(options)
      expect(options.set.has(options)).toBe(true)
    }
    expect(extended.options.left.entries).not.toBe(extended.options.right.entries)
  })

  it("preserves aliases for a repeated parent and override pair", () => {
    const shared = { value: 1 }
    const override = { value: 2 }
    const preset = defineAgent({ options: { left: shared, right: shared, unchanged: shared }, configure: () => defineAgent({ driver: "codex" }) })
    const extended = defineAgent({ extends: preset, options: { left: override, right: override } })
    expect(extended.options.left.value).toBe(2)
    expect(extended.options.left).toBe(extended.options.right)
    expect(extended.options.unchanged.value).toBe(1)
    expect(extended.options.unchanged).not.toBe(extended.options.left)
  })

  it("keeps inherited root cycles and shared child-only aliases", () => {
    const shared: { self?: unknown } = {}
    shared.self = shared
    const defaults: { value: number, self?: unknown, entries: unknown[], added?: { left: typeof shared, right: typeof shared } } = { value: 1, entries: [] }
    defaults.self = defaults
    defaults.entries.push(defaults)
    const preset = defineAgent({ options: defaults, configure: () => defineAgent({ driver: "codex" }) })
    const extended = defineAgent({ extends: preset, options: { value: 2, self: undefined, added: { left: shared, right: shared } } })
    expect(extended.options.self).toBe(extended.options)
    expect(extended.options.entries[0]).toBe(extended.options)
    expect(extended.options.added?.left).toBe(extended.options.added?.right)
    expect(extended.options.added?.left.self).toBe(extended.options.added?.left)
  })
})

it("preserves child-only aliases across distinct merged parent records", () => {
  const extra = { value: 3 }
  const defaults: { left: { value: number, extra?: typeof extra }, right: { value: number, extra?: typeof extra } } = { left: { value: 1 }, right: { value: 2 } }
  const preset = defineAgent({ options: defaults, configure: () => defineAgent({ driver: "codex" }) })
  const extended = defineAgent({ extends: preset, options: { left: { extra }, right: { extra } } })
  expect(extended.options.left.extra).toBe(extended.options.right.extra)
  expect(extended.options.left.extra).not.toBe(extra)
  expect(extended.options.left.value).toBe(1)
  expect(extended.options.right.value).toBe(2)
})

it("preserves option descriptors without invoking accessors during extension", () => {
  const getter = vi.fn(() => "secret")
  const defaults = { sibling: 1, nested: { value: 1 } }
  Object.defineProperty(defaults, "hidden", { value: { secret: true }, enumerable: false, writable: false })
  Object.defineProperty(defaults, "accessor", { get: getter, enumerable: true })
  Object.defineProperty(defaults, "nested", { value: defaults.nested, writable: false })
  const preset = defineAgent({ options: defaults, configure: () => defineAgent({ driver: "codex" }) })
  const overrides = { sibling: 2, nested: { value: 2 } }
  Object.defineProperty(overrides, "nested", { value: overrides.nested, writable: false })
  const extended = defineAgent({ extends: preset, options: overrides })
  expect(getter).not.toHaveBeenCalled()
  expect(Object.getOwnPropertyDescriptor(extended.options, "accessor")?.get).toBe(getter)
  expect(Object.getOwnPropertyDescriptor(extended.options, "hidden")).toMatchObject({ enumerable: false, writable: false, configurable: false, value: { secret: true } })
  expect(Object.getOwnPropertyDescriptor(extended.options, "nested")?.writable).toBe(false)
  expect(extended.options.nested.value).toBe(2)
  expect(extended.options.sibling).toBe(2)
})

it("preserves array accessors in callback and public option copies", () => {
  const getter = vi.fn(() => 7)
  const setter = vi.fn((_value: number) => {})
  const entries = [1, 2]
  Object.defineProperty(entries, "0", { get: getter, set: setter, enumerable: true, configurable: true })
  Object.defineProperty(entries, "hidden", { get: getter, enumerable: false })
  const configure = vi.fn((_options: { entries: number[] }) => defineAgent({ driver: "codex" }))
  const preset = defineAgent({ options: { entries }, configure })
  const extended = defineAgent({ extends: preset, options: {} })
  expect(getter).not.toHaveBeenCalled()
  expect(setter).not.toHaveBeenCalled()
  for (const options of [preset.options, extended.options, ...configure.mock.calls.map(([options]) => options)]) {
    expect(options.entries).not.toBe(entries)
    expect(Object.getOwnPropertyDescriptor(options.entries, "0")).toMatchObject({ get: getter, set: setter, enumerable: true })
    expect(Object.getOwnPropertyDescriptor(options.entries, "hidden")).toMatchObject({ get: getter, enumerable: false })
    expect(options.entries[1]).toBe(2)
  }
})

it("preserves non-writable array length in callback and public option copies", () => {
  const entries = [1, , 3]
  Object.defineProperty(entries, "length", { writable: false })
  const configure = vi.fn((_options: { entries: (number | undefined)[] }) => defineAgent({ driver: "codex" }))
  const preset = defineAgent({ options: { entries }, configure })
  const extended = defineAgent({ extends: preset, options: {} })
  const replaced = defineAgent({ extends: preset, options: { entries } })
  for (const options of [preset.options, extended.options, replaced.options, ...configure.mock.calls.map(([options]) => options)]) {
    expect(options.entries).not.toBe(entries)
    expect(options.entries).toEqual(entries)
    expect(1 in options.entries).toBe(false)
    expect(Object.getOwnPropertyDescriptor(options.entries, "length")).toEqual(Object.getOwnPropertyDescriptor(entries, "length"))
    expect(() => options.entries.push(4)).toThrow(TypeError)
  }
})

it("preserves custom array instances through configuration and extension", () => {
  class Entries extends Array<string> {
    #separator = ","
    summary() { return this.join(this.#separator) }
  }
  const initial = new Entries("default")
  const replacement = new Entries("override")
  const configure = vi.fn((options: { nested: { entries: Entries } }) => {
    expect(options.nested.entries.summary()).toBe(options.nested.entries[0])
    return defineAgent({ driver: "codex" })
  })
  const preset = defineAgent({ options: { nested: { entries: initial } }, configure })
  const inherited = defineAgent({ extends: preset })
  const extended = defineAgent({ extends: preset, options: { nested: { entries: replacement } } })
  expect(preset.options.nested.entries).toBe(initial)
  expect(inherited.options.nested.entries).toBe(initial)
  expect(extended.options.nested.entries).toBe(replacement)
  expect(configure.mock.calls.map(([options]) => options.nested.entries)).toEqual([initial, initial, replacement])
  expect(configure.mock.calls.at(-1)![0].nested.entries).toBe(replacement)
})

it("preserves custom Map instances through configuration and extension", () => {
  class Entries extends Map<string, string> {
    #key = "value"
    summary() { return this.get(this.#key) }
  }
  const initial = new Entries([["value", "default"]])
  const replacement = new Entries([["value", "override"]])
  const configure = vi.fn((options: { nested: { entries: Entries } }) => {
    expect(options.nested.entries.summary()).toBe(options.nested.entries.get("value"))
    return defineAgent({ driver: "codex" })
  })
  const preset = defineAgent({ options: { nested: { entries: initial } }, configure })
  const inherited = defineAgent({ extends: preset })
  const extended = defineAgent({ extends: preset, options: { nested: { entries: replacement } } })
  expect(preset.options.nested.entries).toBe(initial)
  expect(inherited.options.nested.entries).toBe(initial)
  expect(extended.options.nested.entries).toBe(replacement)
  expect(configure.mock.calls.map(([options]) => options.nested.entries)).toEqual([initial, initial, replacement])
  expect(configure.mock.calls.at(-1)![0].nested.entries).toBe(replacement)
})

it("preserves custom Set instances through configuration and extension", () => {
  class Entries extends Set<string> {
    #key = "default"
    summary() { return this.has(this.#key) }
  }
  const initial = new Entries(["default"])
  const replacement = new Entries(["override"])
  const configure = vi.fn((options: { nested: { entries: Entries } }) => {
    expect(options.nested.entries.summary()).toBe(options.nested.entries.has("default"))
    return defineAgent({ driver: "codex" })
  })
  const preset = defineAgent({ options: { nested: { entries: initial } }, configure })
  const inherited = defineAgent({ extends: preset })
  const extended = defineAgent({ extends: preset, options: { nested: { entries: replacement } } })
  expect(preset.options.nested.entries).toBe(initial)
  expect(inherited.options.nested.entries).toBe(initial)
  expect(extended.options.nested.entries).toBe(replacement)
  expect(configure.mock.calls.map(([options]) => options.nested.entries)).toEqual([initial, initial, replacement])
  expect(configure.mock.calls.at(-1)![0].nested.entries).toBe(replacement)
})

it("replaces class option values with complete instances", () => {
  class Client {
    constructor(public endpoint: string) {}
    connect() { return this.endpoint }
  }
  const initial = new Client("default")
  const replacement = new Client("override")
  const configure = vi.fn((options: { client: Client }) => {
    expect(options.client.connect()).toBe(options.client.endpoint)
    return defineAgent({ driver: "codex" })
  })
  const preset = defineAgent({ options: { client: initial }, configure })
  const extended = defineAgent({ extends: preset, options: { client: replacement } })
  expect(preset.options.client).toBe(initial)
  expect(extended.options.client).toBe(replacement)
  expect(configure.mock.calls.at(-1)![0].client).toBe(replacement)
  expect(extended.options.client.connect()).toBe("override")
})

it("preserves branded option values through configuration and extension", () => {
  const key = {}
  const initial = {
    cache: new WeakMap([[key, "default"]]),
    members: new WeakSet([key]),
    error: new Error("default"),
  }
  const replacement = {
    cache: new WeakMap([[key, "override"]]),
    members: new WeakSet([key]),
    error: new Error("override"),
  }
  const configure = vi.fn((_options: { nested: typeof initial }) => defineAgent({ driver: "codex" }))
  const preset = defineAgent({ options: { nested: initial }, configure })
  const inherited = defineAgent({ extends: preset, options: {} })
  const extended = defineAgent({ extends: preset, options: { nested: replacement } })
  for (const [options, expected] of [
    [preset.options, initial],
    [inherited.options, initial],
    [extended.options, replacement],
    ...configure.mock.calls.map(([options], index) => [options, index === 2 ? replacement : initial] as const),
  ] as const) {
    expect(options.nested).not.toBe(expected)
    expect(options.nested.cache).toBe(expected.cache)
    expect(options.nested.cache.get(key)).toBe(expected.error.message)
    expect(options.nested.members).toBe(expected.members)
    expect(options.nested.members.has(key)).toBe(true)
    expect(options.nested.error).toBe(expected.error)
  }
})

it.each([
  ["Date", new class extends Date { #label = "date"; summary() { return this.#label } }()],
  ["RegExp", new class extends RegExp { #label = "regexp"; summary() { return this.#label } }("pattern")],
  ["URL", new class extends URL { #label = "url"; summary() { return this.#label } }("https://example.com")],
  ["URLSearchParams", new class extends URLSearchParams { #label = "params"; summary() { return this.#label } }("q=value")],
  ["ArrayBuffer", new class extends ArrayBuffer { #label = "buffer"; summary() { return this.#label } }(8)],
  ["SharedArrayBuffer", new class extends SharedArrayBuffer { #label = "shared"; summary() { return this.#label } }(8)],
  ["DataView", new class extends DataView<ArrayBuffer> { #label = "view"; summary() { return this.#label } }(new ArrayBuffer(8))],
  ["Uint8Array", new class extends Uint8Array { #label = "bytes"; summary() { return this.#label } }(8)],
] as const)("preserves custom %s instances through configuration and extension", (_name, instance) => {
  const configure = vi.fn((options: { nested: { instance: typeof instance } }) => {
    expect(options.nested.instance).toBe(instance)
    expect(options.nested.instance.summary()).toBe(instance.summary())
    return defineAgent({ driver: "codex" })
  })
  const preset = defineAgent({ options: { nested: { instance } }, configure })
  const inherited = defineAgent({ extends: preset })
  expect(preset.options.nested.instance).toBe(instance)
  expect(inherited.options.nested.instance).toBe(instance)
  expect(configure).toHaveBeenCalledTimes(2)
})
