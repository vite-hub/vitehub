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
