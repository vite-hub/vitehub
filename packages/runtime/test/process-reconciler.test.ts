import { afterEach, describe, expect, it, vi } from "vitest"

import { createProcessReconciler } from "../src/node.ts"

afterEach(() => {
  vi.useRealTimers()
})

function deferred<T = void>(): {
  promise: Promise<T>
  reject: (error: unknown) => void
  resolve: (value: T | PromiseLike<T>) => void
} {
  let reject!: (error: unknown) => void
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return { promise, reject, resolve }
}

describe("createProcessReconciler", () => {
  it("coalesces synchronous wakes and keeps the latest reason", async () => {
    const run = vi.fn()
    const reconciler = createProcessReconciler({ intervalMs: 60_000, run, signal: false })

    reconciler.wake("webhook")
    reconciler.wake("queue")

    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(run).toHaveBeenCalledWith("queue", expect.objectContaining({ track: expect.any(Function) }))
    await reconciler.close()
  })

  it("runs once more when work arrives during reconciliation", async () => {
    const first = deferred()
    const reasons: string[] = []
    const reconciler = createProcessReconciler({
      intervalMs: 60_000,
      run: async (reason) => {
        reasons.push(reason)
        if (reasons.length === 1) await first.promise
      },
      signal: false,
    })

    reconciler.wake("startup")
    await vi.waitFor(() => expect(reasons).toEqual(["startup"]))
    reconciler.wake("webhook")
    reconciler.wake("queue")
    first.resolve()

    await vi.waitFor(() => expect(reasons).toEqual(["startup", "queue"]))
    await reconciler.close()
  })

  it("quiesces and waits for tracked work before reporting drained", async () => {
    const work = deferred()
    const lifecycle: string[] = []
    const reconciler = createProcessReconciler({
      intervalMs: 60_000,
      onDrained: () => { lifecycle.push("drained") },
      onQuiesce: () => { lifecycle.push("quiesced") },
      run(_reason, context) {
        lifecycle.push("running")
        context.track(work.promise)
      },
      signal: false,
    })
    reconciler.wake("startup")
    await vi.waitFor(() => expect(lifecycle).toEqual(["running"]))

    const draining = reconciler.drain()
    await vi.waitFor(() => expect(lifecycle).toEqual(["running", "quiesced"]))
    expect(reconciler.status()).toBe("draining")
    work.resolve()
    await draining

    expect(lifecycle).toEqual(["running", "quiesced", "drained"])
    expect(reconciler.status()).toBe("drained")
  })

  it("reports run failures and continues periodic repair", async () => {
    vi.useFakeTimers()
    const onError = vi.fn()
    const run = vi.fn(async (reason: string) => {
      if (reason === "startup") throw new Error("transient")
    })
    const reconciler = createProcessReconciler({ intervalMs: 1_000, onError, run, signal: false })

    reconciler.wake("startup")
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "transient" }), "startup")
    expect(run).toHaveBeenCalledWith("repair", expect.anything())
    await reconciler.close()
  })

  it("fails the drain when tracked work fails", async () => {
    const work = deferred()
    const reconciler = createProcessReconciler({ intervalMs: 60_000, run() {}, signal: false })
    reconciler.track(work.promise)
    const draining = reconciler.drain()
    work.reject(new Error("unfinished work failed"))

    await expect(draining).rejects.toThrow("unfinished work failed")
    expect(reconciler.status()).toBe("failed")
  })

  it("removes its signal listener when closed", async () => {
    const listeners = process.listenerCount("SIGUSR2")
    const reconciler = createProcessReconciler({ intervalMs: 60_000, run() {}, signal: "SIGUSR2" })

    expect(process.listenerCount("SIGUSR2")).toBe(listeners + 1)
    await reconciler.close()
    expect(process.listenerCount("SIGUSR2")).toBe(listeners)
  })

  it("rejects invalid repair intervals", () => {
    expect(() => createProcessReconciler({ intervalMs: 0, run() {} })).toThrow(
      "Process reconciler intervalMs must be positive.",
    )
  })
})
