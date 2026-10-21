import vm from "node:vm"
import { describe, expect, it, vi } from "vitest"
import { resolveAgentCapabilities, snapshotCapabilityData } from "../src/capability-runtime.ts"

function runtime() {
  return { capabilities: {}, memo: vi.fn(), runtime: "unknown" as const, runtimeConfig: {}, waitUntil: vi.fn() }
}

const foreignValues = vm.runInNewContext(`({
  date: new Date("2020-01-01T00:00:00.000Z"),
  regexp: Object.assign(/foo/gi, { lastIndex: 2 }),
  map: new Map([["key", { nested: true }]]),
  set: new Set([{ nested: true }]),
  arrayBuffer: new Uint8Array([1, 2, 3]).buffer,
  number: new Number(3),
  string: new String("hello"),
  boolean: new Boolean(true),
})`) as Record<string, object>

describe("capability input snapshots", () => {
  it.each(Object.entries(foreignValues))("clones cross-realm %s values", (name, value) => {
    const snapshot = snapshotCapabilityData(value)
    expect(snapshot).not.toBe(value)
    if (name === "map") expect([...((snapshot as Map<string, object>).values())][0]).not.toBe([...((value as unknown as Map<string, object>).values())][0])
    if (name === "set") expect([...((snapshot as Set<object>).values())][0]).not.toBe([...((value as unknown as Set<object>).values())][0])
  })

  it.each(Object.entries(foreignValues))("detects cross-realm %s mutations", async (name, value) => {
    const data = { value }
    const resolved = await resolveAgentCapabilities(undefined, runtime(), { data })
    if (name === "date") (value as unknown as Date).setUTCFullYear(2021)
    else if (name === "regexp") (value as unknown as RegExp).lastIndex = 5
    else if (name === "map") (value as unknown as Map<string, object>).set("changed", {})
    else if (name === "set") (value as unknown as Set<object>).add({ changed: true })
    else if (name === "arrayBuffer") new Uint8Array(value as unknown as ArrayBuffer)[0] = 9
    else if (name === "number") (value as unknown as { valueOf: () => number }).valueOf = () => 4
    else if (name === "string") Reflect.set(value, "extra", "changed")
    else if (name === "boolean") Reflect.set(value, "extra", "changed")
    expect(resolved.inputDataChanged(), name).toBe(true)
  })

  it.each(["local", "foreign"])("snapshots %s records with tagged Object prototypes", async (realm) => {
    // The VM expression returns the same record shape as the local fixture.
    const value = realm === "local" ? { nested: { count: 1 } } : vm.runInNewContext("({ nested: { count: 1 } })") as { nested: { count: number } }
    const prototype = Object.getPrototypeOf(value)
    const original = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag)
    const resolved = await resolveAgentCapabilities(undefined, runtime(), { data: { value } })
    let snapshot: unknown
    let unchanged = false
    let changed = false
    try {
      Object.defineProperty(prototype, Symbol.toStringTag, { configurable: true, value: "TaggedRecord" })
      snapshot = snapshotCapabilityData(value)
      unchanged = !resolved.inputDataChanged()
      value.nested.count = 2
      changed = resolved.inputDataChanged()
    }
    finally {
      if (original) Object.defineProperty(prototype, Symbol.toStringTag, original)
      else Reflect.deleteProperty(prototype, Symbol.toStringTag)
    }
    expect(snapshot).not.toBe(value)
    expect(snapshot).toEqual({ nested: { count: 1 } })
    expect(Object.getPrototypeOf(snapshot)).toBe(prototype)
    expect(unchanged).toBe(true)
    expect(changed).toBe(true)
  })

  it("snapshots URL built-ins without relying on realm constructors", () => {
    const url = new URL("https://example.test/path?query=1")
    const params = new URLSearchParams("query=1")
    expect(snapshotCapabilityData(url)).toEqual(url)
    expect(snapshotCapabilityData(params)).toEqual(params)
    expect(snapshotCapabilityData(url)).not.toBe(url)
    expect(snapshotCapabilityData(params)).not.toBe(params)
  })

  it.each([
    ["Map", () => {
      const entry = Proxy.revocable({}, {})
      entry.revoke()
      return new Map([["key", entry.proxy]])
    }],
    ["Set", () => {
      const entry = Proxy.revocable({}, {})
      entry.revoke()
      return new Set([entry.proxy])
    }],
  ])("does not retain a partial %s snapshot when an entry cannot be copied", (_name, create) => {
    const value = create()
    expect(() => snapshotCapabilityData(value)).not.toThrow()
    expect(snapshotCapabilityData(value)).toBe(value)
  })

  it.each(["Map", "Set"] as const)("snapshots branded %s values with overridden tags", async (name) => {
    const value = name === "Map" ? new Map([["key", 1]]) : new Set([1])
    Object.defineProperty(value, Symbol.toStringTag, { configurable: true, value: "Custom" })
    const resolved = await resolveAgentCapabilities(undefined, runtime(), { data: { value } })
    const snapshot = snapshotCapabilityData(value)
    expect(snapshot).not.toBe(value)
    expect(resolved.inputDataChanged()).toBe(false)
    if (name === "Map") (value as Map<string, number>).set("changed", 2)
    else (value as Set<number>).add(2)
    expect(resolved.inputDataChanged()).toBe(true)
  })
})
