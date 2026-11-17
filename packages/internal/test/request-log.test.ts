import { describe, expect, it, vi } from "vitest"

import { requestLog } from "../src/runtime/request-log.ts"

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
