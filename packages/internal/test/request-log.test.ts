import { afterEach, describe, expect, it, vi } from "vitest"

import { emitLogEvent, errorCode, logFailure, requestLog, setEvlogBridge } from "../src/runtime/request-log.ts"

function evlogLogger() {
  return { set: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe("requestLog", () => {
  it("finds evlog's logger on a Nitro v3 event and on its Request", () => {
    const log = evlogLogger()
    const request = Object.assign(new Request("https://shop.example/orders"), { context: { log } })

    expect(requestLog({ req: request })).toBe(log)
    expect(requestLog(request)).toBe(log)
  })

  it("returns undefined without evlog", () => {
    expect(requestLog({ req: new Request("https://shop.example/orders") })).toBeUndefined()
    expect(requestLog(new Request("https://shop.example/orders"))).toBeUndefined()
    expect(requestLog({ req: { context: { log: { set: vi.fn() } } } })).toBeUndefined()
    expect(requestLog(undefined)).toBeUndefined()
    expect(requestLog(null)).toBeUndefined()
  })
})

describe("logFailure", () => {
  afterEach(() => {
    setEvlogBridge(undefined)
  })

  function bridge() {
    const events: Array<{ fields: Record<string, unknown>, calls: unknown[][] }> = []
    const drained: unknown[] = []
    setEvlogBridge({
      createLogger(fields) {
        const event = { fields, calls: [] as unknown[][] }
        events.push(event)
        return {
          info: message => event.calls.push(["info", message]),
          warn: message => event.calls.push(["warn", message]),
          error: error => event.calls.push(["error", error]),
          emit: () => ({ ...fields, level: "warn" }),
        }
      },
      drain: event => drained.push(event),
    })
    return { drained, events }
  }

  it("sets the field on the wide event of a request that has an evlog logger", () => {
    const log = evlogLogger()
    const request = Object.assign(new Request("https://shop.example/orders"), { context: { log } })
    const fallback = vi.fn()
    const { events } = bridge()

    logFailure({ field: "blob", fields: { op: "cache-write", store: "photos" }, message: "Blob cache write failed", error: Object.assign(new Error("disk full"), { code: "ENOSPC" }), request }, fallback)

    expect(log.warn).toHaveBeenCalledWith("Blob cache write failed: disk full", { blob: { op: "cache-write", store: "photos", code: "ENOSPC" } })
    expect(events).toEqual([])
    expect(fallback).not.toHaveBeenCalled()
  })

  it("emits an event of its own without a request, and sends it to the drain hooks", () => {
    const { drained, events } = bridge()
    const fallback = vi.fn()
    const error = new TypeError("fetch failed")

    logFailure({ field: "kv", fields: { op: "expiry-sweep" }, level: "error", message: "KV sweep failed", error }, fallback)

    expect(events).toEqual([{ fields: { action: "kv", message: "KV sweep failed", kv: { op: "expiry-sweep", code: "TypeError" } }, calls: [["error", error]] }])
    expect(drained).toEqual([{ action: "kv", message: "KV sweep failed", kv: { op: "expiry-sweep", code: "TypeError" }, level: "warn" }])
    expect(fallback).not.toHaveBeenCalled()
  })

  it("calls the fallback without evlog, and never throws", () => {
    const fallback = vi.fn(() => { throw new Error("console is gone") })
    expect(() => logFailure({ field: "kv", fields: {}, message: "KV sweep failed" }, fallback)).not.toThrow()
    expect(fallback).toHaveBeenCalledOnce()
  })

  it("names the cause by its code or class, never by its message", () => {
    expect(errorCode(Object.assign(new Error("open '/srv/secret.txt'"), { code: "EACCES" }))).toBe("EACCES")
    expect(errorCode(new RangeError("too big"))).toBe("RangeError")
    expect(errorCode(new Error("plain"))).toBeUndefined()
    expect(errorCode("text")).toBeUndefined()
  })
})

describe("emitLogEvent", () => {
  afterEach(() => {
    setEvlogBridge(undefined)
  })

  it("returns false without evlog, and when evlog throws", () => {
    expect(emitLogEvent({ field: "schedule", fields: {}, level: "info", message: "Schedule run succeeded" })).toBe(false)
    setEvlogBridge({ createLogger: () => { throw new Error("evlog broke") } })
    expect(emitLogEvent({ field: "schedule", fields: {}, level: "info", message: "Schedule run succeeded" })).toBe(false)
  })
})
