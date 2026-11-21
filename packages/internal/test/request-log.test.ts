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

  it("sets the field on the wide event of a request that has an evlog logger, without the error's message", () => {
    const log = evlogLogger()
    const request = Object.assign(new Request("https://shop.example/orders"), { context: { log } })
    const fallback = vi.fn()
    const { events } = bridge()

    logFailure({ field: "blob", fields: { op: "cache-write", store: "photos" }, message: "Blob cache write failed", error: Object.assign(new Error("ENOSPC: open '/srv/users/42/passport.jpg'"), { code: "ENOSPC" }), request }, fallback)

    expect(log.warn).toHaveBeenCalledWith("Blob cache write failed", { blob: { op: "cache-write", store: "photos", code: "ENOSPC" } })
    expect(JSON.stringify([log.warn.mock.calls, log.set.mock.calls, log.error.mock.calls])).not.toContain("passport")
    expect(events).toEqual([])
    expect(fallback).not.toHaveBeenCalled()
  })

  it("emits an event of its own without a request, sends it to the drain hooks, and keeps them alive", async () => {
    const { drained, events } = bridge()
    const fallback = vi.fn()
    const waitUntil = vi.fn()

    logFailure({ field: "kv", fields: { op: "expiry-sweep" }, level: "error", message: "KV sweep failed", error: new TypeError("fetch https://db.internal/?token=secret failed"), waitUntil }, fallback)
    await Promise.resolve()

    expect(events).toEqual([{ fields: { action: "kv", message: "KV sweep failed", kv: { op: "expiry-sweep", code: "TypeError" } }, calls: [["error", "KV sweep failed"]] }])
    expect(JSON.stringify(events)).not.toContain("secret")
    expect(drained).toEqual([{ action: "kv", message: "KV sweep failed", kv: { op: "expiry-sweep", code: "TypeError" }, level: "warn" }])
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
    expect(fallback).not.toHaveBeenCalled()
  })

  it("prints a failed drain like evlog does", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const failure = new Error("Axiom is down")
    setEvlogBridge({ createLogger: fields => ({ info() {}, warn() {}, error() {}, emit: () => fields }), drain: () => Promise.reject(failure) })

    const drains: Promise<unknown>[] = []
    logFailure({ field: "kv", fields: {}, message: "KV sweep failed", waitUntil: promise => drains.push(promise) }, vi.fn())
    await Promise.all(drains)

    expect(consoleError).toHaveBeenCalledWith("[evlog] drain failed:", failure)
    consoleError.mockRestore()
  })

  it("calls the fallback when evlog is off, also for a request with a logger", () => {
    const log = evlogLogger()
    const request = Object.assign(new Request("https://shop.example/orders"), { context: { log } })
    const fallback = vi.fn()
    setEvlogBridge({ createLogger: vi.fn(), isEnabled: () => false })

    logFailure({ field: "blob", fields: {}, message: "Blob cache write failed", request }, fallback)

    expect(log.warn).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
  })

  it("calls the fallback without the bridge, also for a request with a logger", () => {
    const log = evlogLogger()
    const request = Object.assign(new Request("https://shop.example/orders"), { context: { log } })
    const fallback = vi.fn()

    logFailure({ field: "blob", fields: {}, message: "Blob cache write failed", request }, fallback)

    expect(log.warn).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
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

  it("puts the Error on the event only when asked", () => {
    const calls: unknown[] = []
    setEvlogBridge({ createLogger: fields => ({ info() {}, warn() {}, error: error => calls.push(error), emit: () => fields }) })
    const failure = new Error("The digest API answered 502.")

    emitLogEvent({ field: "schedule", fields: {}, level: "error", message: "Schedule run failed", error: failure })
    emitLogEvent({ field: "schedule", fields: {}, level: "error", message: "Schedule run failed", error: failure, withError: true })

    expect(calls).toEqual(["Schedule run failed", failure])
  })

  it("returns false when the app turned evlog off, so the caller prints to the console", () => {
    const createLogger = vi.fn()
    setEvlogBridge({ createLogger, isEnabled: () => false })
    expect(emitLogEvent({ field: "schedule", fields: {}, level: "info", message: "Schedule run succeeded" })).toBe(false)
    expect(createLogger).not.toHaveBeenCalled()
  })
})
