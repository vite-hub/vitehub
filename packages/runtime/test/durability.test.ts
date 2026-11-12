import { describe, expect, it, vi } from "vitest"

import { checkDurability, classifySqliteUrl, collectDurability, formatDurabilityTable, getDurabilityReport, readInstanceCount, resolveDurabilityValue, sqliteUrlInput } from "../src/durability.ts"

import type { Durability } from "../src/durability.ts"

const kv: Durability = { primitive: "kv", store: "fs-lite", scope: "host", reason: "Files in .vitehub/data/kv on this host.", fix: "Use Upstash Redis." }
const cache: Durability = { primitive: "kv", name: "cache", store: "upstash", scope: "shared", reason: "Upstash Redis over HTTP." }
const rateLimit: Durability = { primitive: "rate-limit", store: "memory", scope: "process", reason: "Counters live in the memory of this process.", fix: "Run one instance." }

describe("durability table", () => {
  it("prints one aligned line per primitive", () => {
    expect(formatDurabilityTable([kv, cache, rateLimit])).toBe([
      "  kv          fs-lite  host     Files in .vitehub/data/kv on this host.",
      "  kv (cache)  upstash  shared   Upstash Redis over HTTP.",
      "  rate-limit  memory   process  Counters live in the memory of this process.",
    ].join("\n"))
  })
})

describe("instance count", () => {
  it("defaults to 1", () => {
    expect(readInstanceCount({})).toEqual({ instances: 1, instancesSource: "default" })
  })

  it("lets VITEHUB_INSTANCES override node.instances", () => {
    expect(readInstanceCount({}, 2)).toEqual({ instances: 2, instancesSource: "option" })
    expect(readInstanceCount({ VITEHUB_INSTANCES: " 3 " }, 2)).toEqual({ instances: 3, instancesSource: "env" })
  })

  it.each(["0", "-1", "1.5", "three"])("rejects VITEHUB_INSTANCES=%s", (value) => {
    expect(() => readInstanceCount({ VITEHUB_INSTANCES: value })).toThrow(/RUNTIME_R0018|must be a positive integer/)
  })

  it("rejects a node.instances that is not a positive integer", () => {
    expect(() => readInstanceCount({}, 0)).toThrow("node.instances must be a positive integer")
  })
})

describe("checkDurability", () => {
  it("prints the table and records the report for one instance", () => {
    const log = vi.fn()
    const report = checkDurability([kv, rateLimit], { env: {}, log })
    expect(report).toMatchObject({ instances: 1, instancesSource: "default", problems: [] })
    expect(getDurabilityReport()).toBe(report)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toContain("[vitehub] Durability (1 instance. Set VITEHUB_INSTANCES when you run more):")
    expect(log.mock.calls[0]![0]).toContain("rate-limit  memory   process")
  })

  it("fails with each host or process primitive and its fix when several instances run", () => {
    let error: unknown
    try {
      checkDurability([kv, cache, rateLimit], { env: { VITEHUB_INSTANCES: "3" }, log: false })
    }
    catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect((error as Error).name).toBe("RUNTIME_R0017")
    expect(message).toContain("VITEHUB_INSTANCES is 3, but these primitives keep their state in one process or on one host.")
    expect(message).toContain("  - kv: fs-lite (host). Files in .vitehub/data/kv on this host. Fix: Use Upstash Redis.")
    expect(message).toContain("  - rate-limit: memory (process). Counters live in the memory of this process. Fix: Run one instance.")
    expect(message).not.toContain("kv (cache)")
    expect(getDurabilityReport()?.problems).toEqual([kv, rateLimit])
  })

  it("passes several instances when every primitive is shared", () => {
    expect(checkDurability([cache], { env: {}, instances: 3, log: false }).problems).toEqual([])
  })

  it("only records the report when it does not enforce", () => {
    expect(checkDurability([kv], { enforce: false, env: { VITEHUB_INSTANCES: "2" }, log: false }).problems).toEqual([kv])
  })
})

describe("collectDurability", () => {
  it("runs a reporter that another one finds first, once, whatever the order", () => {
    const runs: string[] = []
    const reports = collectDurability([
      { primitive: "rate-limit", report: ({ find }) => { runs.push("rate-limit"); return [{ ...rateLimit, scope: find("kv")!.scope }] } },
      { primitive: "kv", report: () => { runs.push("kv"); return [kv, cache] } },
    ], {})
    expect(runs).toEqual(["rate-limit", "kv"])
    expect(reports.map(report => [report.primitive, report.name, report.scope])).toEqual([
      ["rate-limit", undefined, "host"],
      ["kv", undefined, "host"],
      ["kv", "cache", "shared"],
    ])
  })

  it("finds a named store, and nothing for a primitive that is off", () => {
    collectDurability([
      {
        primitive: "queue",
        report: ({ find }) => {
          expect(find("kv", "cache")).toBe(cache)
          expect(find("database")).toBeUndefined()
          return []
        },
      },
      { primitive: "kv", report: () => [kv, cache] },
    ], {})
  })
})

describe("classifySqliteUrl", () => {
  it.each([
    ["file:.vitehub/data/database/sqlite.db", "sqlite", "host"],
    ["file:///var/lib/app/state.db", "sqlite", "host"],
    [":memory:", "sqlite", "process"],
    ["libsql://app.turso.io", "libsql", "shared"],
    ["https://app.turso.io", "libsql", "shared"],
    ["remote", "libsql", "shared"],
  ])("classifies %s", (url, store, scope) => {
    expect(classifySqliteUrl(url)).toMatchObject({ store, scope })
  })

  it("keeps file URLs and hides remote ones", () => {
    expect(sqliteUrlInput("file:data.db")).toBe("file:data.db")
    expect(sqliteUrlInput("FiLe:data.db")).toBe("FiLe:data.db")
    expect(sqliteUrlInput("libsql://app.turso.io?authToken=secret")).toBe("remote")
  })
})

it("resolves env declarations the way the runtime does", () => {
  const value = { source: { name: "A", names: ["A", "B"] }, default: "fallback" }
  expect(resolveDurabilityValue(value, { B: " b " })).toBe("b")
  expect(resolveDurabilityValue(value, {})).toBe("fallback")
  expect(resolveDurabilityValue(" x ", {})).toBe("x")
})
