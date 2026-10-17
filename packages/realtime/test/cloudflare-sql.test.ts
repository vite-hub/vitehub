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

  it("rejects a receiver-sensitive JavaScript databaseSize getter", () => {
    function SqlStorage() {}
    const prototype = SqlStorage.prototype
    const exec = function exec() { return { toArray: () => [] } }
    const databaseSize = {
      get databaseSize() {
        return this === Object.create(prototype) ? (() => { throw new Error("forged") })() : 0
      },
    }
    Object.defineProperties(prototype, {
      exec: { value: exec },
      databaseSize: { get: Object.getOwnPropertyDescriptor(databaseSize, "databaseSize")!.get },
    })

    expect(hasCloudflareSqlExec(Object.create(prototype))).toBe(false)
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

  it("rejects a proxy-wrapped database-size callback that spoofs the receiver probe", () => {
    function SqlStorage() {}
    const prototype = SqlStorage.prototype
    const exec = function exec() { return { toArray: () => [] } }
    const databaseSize = new Proxy((receiver: object) => {
      if (receiver === Object.create(prototype)) throw new Error("forged")
      return 0
    }, {})
    Object.defineProperties(prototype, {
      exec: { value: exec },
      databaseSize: { get: databaseSize as unknown as () => number },
    })

    expect(hasCloudflareSqlExec(Object.create(prototype))).toBe(false)
  })

  it("rejects proxy-wrapped arrow and bound fabricated carriers", () => {
    const constructor = new Proxy((() => {}).bind(null), {})
    const exec = new Proxy((() => ({ toArray: () => [] })).bind(null), {})
    const databaseSize = new Proxy((() => 0).bind(null), {})
    const prototype = Object.defineProperties({}, {
      constructor: { value: constructor },
      exec: { value: exec },
      databaseSize: { get: databaseSize },
    })

    expect(hasCloudflareSqlExec(Object.create(prototype))).toBe(false)
  })

  it("rejects an unrelated native accessor used as databaseSize", () => {
    function SqlStorage() {}
    const prototype = SqlStorage.prototype
    Object.defineProperties(prototype, {
      constructor: { value: SqlStorage },
      exec: { value: function exec() { return { toArray: () => [] } } },
      databaseSize: { get: Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get },
    })

    expect(hasCloudflareSqlExec(Object.create(prototype))).toBe(false)
  })

  it("returns false if proxy inspection throws", () => {
    const sql = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("unavailable") } })
    expect(hasCloudflareSqlExec(sql)).toBe(false)
  })
})
