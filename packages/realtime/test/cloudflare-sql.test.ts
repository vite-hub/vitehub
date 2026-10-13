import { describe, expect, it, vi } from "vitest"
import { hasCloudflareSqlExec } from "../src/cloudflare-sql.ts"

describe("Cloudflare SQL carrier discovery", () => {
  it("accepts an explicit own data executor", () => {
    expect(hasCloudflareSqlExec({ exec: () => ({ toArray: () => [] }) })).toBe(true)
  })

  it("does not invoke an own executor getter", () => {
    const getter = vi.fn()
    expect(hasCloudflareSqlExec(Object.defineProperty({}, "exec", { get: getter }))).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })

  it("rejects a JavaScript constructor and forged native function strings", () => {
    function SqlStorage() {}
    const exec = vi.fn()
    const databaseSize = vi.fn(() => 0)
    SqlStorage.toString = () => "function SqlStorage() { [native code] }"
    exec.toString = () => "function exec() { [native code] }"
    databaseSize.toString = () => "function () { [native code] }"
    const prototype = Object.defineProperties({}, {
      constructor: { value: SqlStorage },
      exec: { value: exec },
      databaseSize: { get: databaseSize },
    })

    expect(hasCloudflareSqlExec(Object.create(prototype))).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    expect(databaseSize).not.toHaveBeenCalled()
  })

  it("rejects proxy-wrapped fabricated native carriers", () => {
    function SqlStorage() {}
    const exec = vi.fn()
    const databaseSize = vi.fn(() => 0)
    const prototype = Object.defineProperties({}, {
      constructor: { value: new Proxy(SqlStorage, {}) },
      exec: { value: new Proxy(exec, {}) },
      databaseSize: { get: new Proxy(databaseSize, {}) },
    })

    expect(hasCloudflareSqlExec(Object.create(prototype))).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    expect(databaseSize).not.toHaveBeenCalled()
  })

  it("returns false if proxy inspection throws", () => {
    const sql = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("unavailable") } })
    expect(hasCloudflareSqlExec(sql)).toBe(false)
  })
})
