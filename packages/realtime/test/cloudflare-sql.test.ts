import { describe, expect, it, vi } from "vitest"
import { hasCloudflareSqlExec, hasNativeCloudflareSql } from "../src/cloudflare-sql.ts"

describe("Cloudflare SQL carrier discovery", () => {
  it("accepts an explicit own data executor", () => {
    const adapter = { exec: () => ({ toArray: () => [] }) }
    expect(hasCloudflareSqlExec(adapter)).toBe(true)
    expect(hasNativeCloudflareSql(adapter)).toBe(false)
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

  it("does not invoke a proxy-wrapped JavaScript getter with an own prototype", () => {
    function SqlStorage() {}
    const prototype = SqlStorage.prototype
    const databaseSize = vi.fn(function () { return 0 })
    Object.defineProperties(prototype, {
      exec: { value: function exec() { return { toArray: () => [] } } },
      databaseSize: { get: new Proxy(databaseSize, {}) },
    })

    expect(hasCloudflareSqlExec(Object.create(prototype))).toBe(false)
    expect(databaseSize).not.toHaveBeenCalled()
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

  it("rejects an unrelated native accessor on a polluted built-in prototype", () => {
    const exec = Object.getOwnPropertyDescriptor(Map.prototype, "get")!.value
    const databaseSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get
    const previousExec = Object.getOwnPropertyDescriptor(Map.prototype, "exec")
    const previousDatabaseSize = Object.getOwnPropertyDescriptor(Map.prototype, "databaseSize")
    try {
      Object.defineProperties(Map.prototype, {
        exec: { configurable: true, value: exec },
        databaseSize: { configurable: true, get: databaseSize },
      })
      expect(hasCloudflareSqlExec(new Map())).toBe(false)
    }
    finally {
      if (previousExec) Object.defineProperty(Map.prototype, "exec", previousExec)
      else delete (Map.prototype as Map<unknown, unknown> & { exec?: unknown }).exec
      if (previousDatabaseSize) Object.defineProperty(Map.prototype, "databaseSize", previousDatabaseSize)
      else delete (Map.prototype as Map<unknown, unknown> & { databaseSize?: unknown }).databaseSize
    }
  })

  it("rejects a proxy-wrapped unrelated native accessor", () => {
    const prototype = Object.create(Map.prototype)
    const constructor = Object.getOwnPropertyDescriptor(Map.prototype, "constructor")!.value
    const exec = function exec() { return { toArray: () => [] } }
    Object.defineProperties(prototype, {
      constructor: { value: constructor },
      exec: { value: exec },
      databaseSize: { get: new Proxy(Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!, {}) },
    })

    expect(hasCloudflareSqlExec(Object.create(prototype))).toBe(false)
  })

  it("rejects the Set size accessor as a counterfeit databaseSize", () => {
    function SqlStorage() {}
    const prototype = Object.create(Set.prototype)
    Object.defineProperties(prototype, {
      constructor: { value: SqlStorage },
      exec: { value: function exec() { return { toArray: () => [] } } },
      databaseSize: { get: Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get },
    })

    expect(hasCloudflareSqlExec(Object.create(prototype))).toBe(false)
  })

  it("rejects the ArrayBuffer byteLength accessor as a counterfeit databaseSize", () => {
    const prototype = Object.create(ArrayBuffer.prototype)
    const constructor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "constructor")!.value
    const databaseSize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get
    Object.defineProperties(prototype, {
      constructor: { value: constructor },
      exec: { value: () => ({ toArray: () => [] }) },
      databaseSize: { get: databaseSize },
    })
    const sql = new ArrayBuffer(0)
    Object.setPrototypeOf(sql, prototype)
    expect(hasCloudflareSqlExec(sql)).toBe(false)
  })

  it("rejects the DataView byteLength accessor as a counterfeit databaseSize", () => {
    const prototype = Object.create(DataView.prototype)
    const constructor = Object.getOwnPropertyDescriptor(DataView.prototype, "constructor")!.value
    const databaseSize = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get
    Object.defineProperties(prototype, {
      constructor: { value: constructor },
      exec: { value: () => ({ toArray: () => [] }) },
      databaseSize: { get: databaseSize },
    })
    const sql = new DataView(new ArrayBuffer(8))
    Object.setPrototypeOf(sql, prototype)
    expect(hasCloudflareSqlExec(sql)).toBe(false)
  })

  it("rejects the typed-array byteLength accessor as a counterfeit databaseSize", () => {
    const prototype = Object.create(Uint8Array.prototype)
    const constructor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "constructor")!.value
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
    const databaseSize = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get
    Object.defineProperties(prototype, {
      constructor: { value: constructor },
      exec: { value: () => ({ toArray: () => [] }) },
      databaseSize: { get: databaseSize },
    })
    const sql = new Uint8Array(0)
    Object.setPrototypeOf(sql, prototype)
    expect(hasCloudflareSqlExec(sql)).toBe(false)
  })

  it("returns false if proxy inspection throws", () => {
    const sql = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("unavailable") } })
    expect(hasCloudflareSqlExec(sql)).toBe(false)
  })
})
