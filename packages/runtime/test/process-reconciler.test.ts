import { afterEach, describe, expect, it, vi } from "vitest"

import { createProcessReconciler } from "../src/node.ts"
import type { ProcessReconciler } from "../src/node.ts"

afterEach(() => {
  vi.useRealTimers()
})

function deferred(): {
  promise: Promise<void>
  reject: (error: unknown) => void
  resolve: () => void
} {
  let reject!: (error: unknown) => void
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
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

  it("drains a wake admitted before its queued execution", async () => {
    const run = vi.fn()
    const reconciler = createProcessReconciler({ intervalMs: 60_000, run, signal: false })

    reconciler.wake("webhook")
    await reconciler.drain()

    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith("webhook", expect.anything())
    expect(reconciler.status()).toBe("drained")
  })

  it("drains a rerun admitted during reconciliation", async () => {
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
    const draining = reconciler.drain()
    first.resolve()
    await draining

    expect(reasons).toEqual(["startup", "webhook"])
    expect(reconciler.status()).toBe("drained")
  })

  it("rejects a drain awaited by the active run", async () => {
    const finished = deferred()
    const reconciler = createProcessReconciler({
      intervalMs: 60_000,
      async run() {
        await expect(reconciler.drain()).rejects.toThrow(
          "Process reconciler callbacks cannot call drain() while active.",
        )
        finished.resolve()
      },
      signal: false,
    })

    reconciler.wake("startup")
    await finished.promise
    await reconciler.drain()

    expect(reconciler.status()).toBe("drained")
  })

  it("rejects a drain awaited by active error reporting", async () => {
    const finished = deferred()
    const reconciler = createProcessReconciler({
      intervalMs: 60_000,
      async onError() {
        await expect(reconciler.drain()).rejects.toThrow(
          "Process reconciler callbacks cannot call drain() while active.",
        )
        finished.resolve()
      },
      run() { throw new Error("reconciliation failed") },
      signal: false,
    })

    reconciler.wake("startup")
    await finished.promise
    await reconciler.drain()

    expect(reconciler.status()).toBe("drained")
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

  it("runs an admitted rerun when error reporting fails", async () => {
    const reasons: string[] = []
    let reconciler!: ProcessReconciler
    const retry = deferred()
    reconciler = createProcessReconciler({
      intervalMs: 60_000,
      onError() {
        reconciler.wake("retry")
        throw new Error("error reporting failed")
      },
      run(reason) {
        reasons.push(reason)
        if (reason === "startup") throw new Error("reconciliation failed")
        return retry.promise
      },
      signal: false,
    })

    reconciler.wake("startup")
    await vi.waitFor(() => expect(reasons).toEqual(["startup", "retry"]))
    const draining = reconciler.drain()
    retry.resolve()

    await expect(draining).rejects.toThrow("error reporting failed")
    expect(reconciler.status()).toBe("failed")
  })

  it("runs a rerun admitted during active-run settlement", async () => {
    const reasons: string[] = []
    let reconciler!: ProcessReconciler
    const retry = deferred()
    reconciler = createProcessReconciler({
      intervalMs: 60_000,
      onError() {
        queueMicrotask(() => queueMicrotask(() => reconciler.wake("retry")))
        throw new Error("error reporting failed")
      },
      run(reason) {
        reasons.push(reason)
        if (reason === "startup") throw new Error("reconciliation failed")
        return retry.promise
      },
      signal: false,
    })

    reconciler.wake("startup")
    await vi.waitFor(() => expect(reasons).toEqual(["startup", "retry"]))
    const draining = reconciler.drain()
    retry.resolve()

    await expect(draining).rejects.toThrow("error reporting failed")
    expect(reconciler.status()).toBe("failed")
  })

  it("queues a wake that arrives after active-run settlement", async () => {
    const reasons: string[] = []
    let reconciler!: ProcessReconciler
    reconciler = createProcessReconciler({
      intervalMs: 60_000,
      run(reason) {
        reasons.push(reason)
        if (reason === "startup") {
          queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => reconciler.wake("retry"))))
        }
      },
      signal: false,
    })

    reconciler.wake("startup")
    await vi.waitFor(() => expect(reasons).toEqual(["startup", "retry"]))
    await reconciler.close()
  })

  it("starts periodic repair without an event-driven wake", async () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const reconciler = createProcessReconciler({ intervalMs: 1_000, run, signal: false })

    await vi.advanceTimersByTimeAsync(1_000)

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

  it("waits for all tracked work before failing the drain", async () => {
    const failed = deferred()
    const unfinished = deferred()
    const reconciler = createProcessReconciler({ intervalMs: 60_000, run() {}, signal: false })
    reconciler.track(failed.promise)
    reconciler.track(unfinished.promise)
    const draining = reconciler.drain()
    failed.reject(new Error("tracked work failed"))
    await Promise.resolve()

    expect(reconciler.status()).toBe("draining")
    unfinished.resolve()

    await expect(draining).rejects.toThrow("tracked work failed")
    expect(reconciler.status()).toBe("failed")
  })

  it("retains failures from work tracked during an active drain", async () => {
    const initial = deferred()
    const late = deferred()
    const reconciler = createProcessReconciler({ intervalMs: 60_000, run() {}, signal: false })
    reconciler.track(initial.promise)
    const draining = reconciler.drain()
    reconciler.track(late.promise)
    late.reject(new Error("late tracked work failed"))
    await Promise.resolve()
    initial.resolve()

    await expect(draining).rejects.toThrow("late tracked work failed")
    expect(reconciler.status()).toBe("failed")
  })

  it("settles admitted work after quiescing fails", async () => {
    const work = deferred()
    const reconciler = createProcessReconciler({
      intervalMs: 60_000,
      onQuiesce: () => { throw new Error("quiescing failed") },
      run() {},
      signal: false,
    })
    reconciler.track(work.promise)

    const draining = reconciler.drain()
    await Promise.resolve()
    expect(reconciler.status()).toBe("draining")
    work.resolve()

    await expect(draining).rejects.toThrow("quiescing failed")
    expect(reconciler.status()).toBe("failed")
  })

  it("settles admitted work after reconciliation error reporting fails", async () => {
    const runStarted = deferred()
    const work = deferred()
    const reconciler = createProcessReconciler({
      intervalMs: 60_000,
      onError: () => { throw new Error("error reporting failed") },
      run(_reason, context) {
        context.track(work.promise)
        runStarted.resolve()
        throw new Error("reconciliation failed")
      },
      signal: false,
    })
    reconciler.wake("startup")
    await runStarted.promise

    const draining = reconciler.drain()
    await Promise.resolve()
    expect(reconciler.status()).toBe("draining")
    work.resolve()

    await expect(draining).rejects.toThrow("error reporting failed")
    expect(reconciler.status()).toBe("failed")
  })

  it("retains nested microtask work at the final drain boundary", async () => {
    const late = deferred()
    const reconciler = createProcessReconciler({
      intervalMs: 60_000,
      onDrained() {
        queueMicrotask(() => queueMicrotask(() => {
          reconciler.track(late.promise)
          late.reject(new Error("final tracked work failed"))
        }))
      },
      run() {},
      signal: false,
    })

    await expect(reconciler.drain()).rejects.toThrow("final tracked work failed")
    expect(reconciler.status()).toBe("failed")
    await expect(reconciler.track(Promise.resolve("terminal"))).resolves.toBe("terminal")
  })

  it("does not retain work tracked after a successful drain", async () => {
    const reconciler = createProcessReconciler({ intervalMs: 60_000, run() {}, signal: false })
    await reconciler.drain()

    await expect(reconciler.track(Promise.resolve("terminal"))).resolves.toBe("terminal")
    expect(reconciler.status()).toBe("drained")
  })

  it("reports drained only after asynchronous cleanup completes", async () => {
    const cleanup = deferred()
    const reconciler = createProcessReconciler({
      intervalMs: 60_000,
      onDrained: () => cleanup.promise,
      run() {},
      signal: false,
    })

    const draining = reconciler.drain()
    await Promise.resolve()
    expect(reconciler.status()).toBe("draining")
    cleanup.resolve()
    await draining

    expect(reconciler.status()).toBe("drained")
  })

  it("removes its signal listener when closed", async () => {
    const listeners = process.listenerCount("SIGUSR2")
    const reconciler = createProcessReconciler({ intervalMs: 60_000, run() {}, signal: "SIGUSR2" })

    expect(process.listenerCount("SIGUSR2")).toBe(listeners + 1)
    await reconciler.close()
    expect(process.listenerCount("SIGUSR2")).toBe(listeners)
  })

  it("retains its signal listener when close rejects", async () => {
    const listeners = process.listenerCount("SIGUSR2")
    let reconciler!: ProcessReconciler
    reconciler = createProcessReconciler({
      intervalMs: 60_000,
      async run() {
        await expect(reconciler.close()).rejects.toThrow("cannot call drain() while active")
      },
      signal: "SIGUSR2",
    })

    reconciler.wake("test")
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(reconciler.status()).toBe("accepting")
    expect(process.listenerCount("SIGUSR2")).toBe(listeners + 1)
    await reconciler.close()
    expect(process.listenerCount("SIGUSR2")).toBe(listeners)
  })

  it("rejects invalid repair intervals", () => {
    expect(() => createProcessReconciler({ intervalMs: 0, run() {} })).toThrow(
      "Process reconciler intervalMs must be between 1 and 2,147,483,647 milliseconds.",
    )
    expect(() => createProcessReconciler({ intervalMs: 0.5, run() {} })).toThrow(
      "Process reconciler intervalMs must be between 1 and 2,147,483,647 milliseconds.",
    )
    expect(() => createProcessReconciler({ intervalMs: 2_147_483_648, run() {} })).toThrow(
      "Process reconciler intervalMs must be between 1 and 2,147,483,647 milliseconds.",
    )
  })

  it.each(["SIGKILL", "SIGSTOP"] as const)("rejects the uncatchable %s signal", (signal) => {
    // SAFETY: This verifies the runtime guard for values intentionally excluded from the public type.
    expect(() => createProcessReconciler({ intervalMs: 60_000, run() {}, signal: signal as never }))
      .toThrow(`Process reconciler signal ${signal} cannot be handled.`)
  })
})
