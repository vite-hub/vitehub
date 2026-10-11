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
    expect(snapshotCapabilityData(value)).not.toBe(value)
  })

  it.each(Object.entries(foreignValues))("detects cross-realm %s mutations", async (name, value) => {
    const data = { value }
    const resolved = await resolveAgentCapabilities(undefined, runtime(), { data })
    if (name === "date") (value as unknown as Date).setUTCFullYear(2021)
    else if (name === "regexp") (value as unknown as RegExp).lastIndex = 5
    else if (name === "map") (value as unknown as Map<string, object>).set("changed", {})
    else if (name === "set") (value as unknown as Set<object>).add({ changed: true })
    else if (name === "arrayBuffer") new Uint8Array(value as unknown as ArrayBuffer)[0] = 9
    else if (name === "number") (value as unknown as Number).valueOf = () => 4
    else if (name === "string") Reflect.set(value, "extra", "changed")
    else if (name === "boolean") Reflect.set(value, "extra", "changed")
    expect(resolved.inputDataChanged(), name).toBe(true)
  })
})
