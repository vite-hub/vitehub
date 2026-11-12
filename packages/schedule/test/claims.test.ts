import { createMemoryLeaseStore, createSqlLeaseStore } from "@vite-hub/runtime"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createOccurrenceClaims } from "../src/runtime/claims.ts"

import type { LeaseStore } from "@vite-hub/runtime"

afterEach(() => vi.useRealTimers())

function claims(leases: LeaseStore, reportError = vi.fn()) {
  return createOccurrenceClaims({ doneTtlMs: 2000, leases, reportError, ttlMs: 300 })
}

const unavailable = createSqlLeaseStore({ dialect: "postgresql", query: async () => { throw new Error("Database unavailable") } })

describe("Schedule occurrence claims", () => {
  it.each([false, true])("keeps a finished occurrence claimed when its done marker fails (handler fails: %s)", async (fails) => {
    vi.useFakeTimers()
    const leases = createMemoryLeaseStore()
    const acquire = leases.acquire.bind(leases)
    let failMarker = true
    vi.spyOn(leases, "acquire").mockImplementation(async (key, options) => {
      if (key.endsWith("/done") && failMarker) {
        failMarker = false
        return unavailable.acquire(key, options)
      }
      return acquire(key, options)
    })
    const handler = vi.fn(async () => { if (fails) throw new Error("Handler failed") })
    const onError = vi.fn()
    const first = claims(leases, onError).run("occurrence", async (markFinal) => {
      markFinal()
      await handler()
    })
    if (fails) await expect(first).rejects.toThrow("Handler failed")
    else expect(await first).toBe("ran")

    await vi.advanceTimersByTimeAsync(1000)
    expect(await claims(leases).run("occurrence", handler)).toBe("held")
    expect(handler).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "RUNTIME_LEASE_FAILED" }))
    await vi.advanceTimersByTimeAsync(1001)
    expect((await leases.get("vitehub:schedule/schedule/occurrence"))[1]).toBeNull()
  })

  it("ignores a renewal result after the run has ended", async () => {
    vi.useFakeTimers()
    const leases = createMemoryLeaseStore()
    const acquire = leases.acquire.bind(leases)
    let finishRenew!: () => void
    vi.spyOn(leases, "acquire").mockImplementation(async (key, options) => {
      const result = await acquire(key, options)
      const lease = result[1]
      if (lease && !key.endsWith("/done")) {
        lease.renew = async () => {
          await new Promise<void>(resolve => { finishRenew = resolve })
          return [undefined, false]
        }
      }
      return result
    })
    let finishRun!: () => void
    const onError = vi.fn()
    const run = claims(leases, onError).run("occurrence", (markFinal) => {
      markFinal()
      return new Promise<void>(resolve => { finishRun = resolve })
    })
    await vi.advanceTimersByTimeAsync(100)
    finishRun()
    await vi.advanceTimersByTimeAsync(0)
    finishRenew()
    expect(await run).toBe("ran")
    await vi.advanceTimersByTimeAsync(0)
    expect(onError).not.toHaveBeenCalled()
  })
})
