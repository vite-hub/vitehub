import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent, runAgent } from "../src/index.ts"
import { recoverInterruptedAgentInvocations } from "../src/invocations.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import type { AgentInvocationStore } from "../src/server.ts"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

/** A store that loads its client on first use, as the Console journal loads libSQL. Every operation waits for that load. */
function lazyStore(open: () => Promise<void>) {
  const backing = createMemoryAgentInvocationStore()
  let opening: Promise<void> | undefined
  const opened = () => opening ??= open().catch((error: unknown) => {
    opening = undefined
    throw error
  })
  const store: AgentInvocationStore = {
    open: opened,
    claim: async (...input) => {
      await opened()
      return backing.claim(...input)
    },
    create: async input => {
      await opened()
      return backing.create(input)
    },
    get: async (...input) => {
      await opened()
      return backing.get(...input)
    },
    getClaimToken: async id => {
      await opened()
      return backing.getClaimToken(id)
    },
    getSummary: async id => {
      await opened()
      return backing.getSummary(id)
    },
    list: async options => {
      await opened()
      return backing.list(options)
    },
    release: async (id, claimId) => {
      await opened()
      return backing.release(id, claimId)
    },
    update: async (...input) => {
      await opened()
      return backing.update(...input)
    },
  }
  return store
}

afterEach(() => {
  vi.useRealTimers()
})

describe("Agent Invocation store open", () => {
  it("does not count a slow first open against storeTimeoutMs", async () => {
    const open = vi.fn(() => new Promise<void>(resolve => setTimeout(resolve, 100)))
    const invocations = defineAgentInvocations({ store: lazyStore(open), storeTimeoutMs: 20 })

    await expect(Promise.all([invocations.list(), invocations.getSummary("missing"), invocations.getByRunId("missing")]))
      .resolves.toEqual([expect.objectContaining({ invocations: [] }), undefined, undefined])
    expect(open).toHaveBeenCalledOnce()
  })

  it("records the first run while the store opens", async () => {
    const invocations = defineAgentInvocations({ store: lazyStore(() => new Promise(resolve => setTimeout(resolve, 100))), storeTimeoutMs: 20, enforcement: "strict" })
    const run = vi.fn(() => "done")

    const [error] = await runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), {})
    expect(error).toBeFalsy()
    expect(run).toHaveBeenCalledOnce()
    await expect(invocations.list()).resolves.toMatchObject({ invocations: [{ status: "completed" }] })
  })

  it("opens before creating the first run in a store that requires initialization", async () => {
    const store = createMemoryAgentInvocationStore()
    const create = store.create.bind(store)
    let ready = false
    store.open = async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      ready = true
    }
    store.create = vi.fn(input => {
      if (!ready) throw new Error("Store is not open")
      return create(input)
    })
    const invocations = defineAgentInvocations({ enforcement: "strict", store, storeTimeoutMs: 20 })
    const run = vi.fn(() => "done")

    const [error] = await runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), {})
    expect(error).toBeFalsy()
    expect(run).toHaveBeenCalledOnce()
    expect(store.create).toHaveBeenCalledOnce()
    await expect(invocations.list()).resolves.toMatchObject({ invocations: [{ status: "completed" }] })
  })

  it("opens again after a rejected open", async () => {
    const open = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Database unavailable"))
      .mockResolvedValue(undefined)
    const invocations = defineAgentInvocations({ store: lazyStore(open) })

    await expect(invocations.list()).rejects.toThrow("Database unavailable")
    await expect(invocations.list()).resolves.toMatchObject({ invocations: [] })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it("shares a slow open between recovery and journal reads", async () => {
    const store = createMemoryAgentInvocationStore()
    await store.create({ id: "interrupted", traceId: "interrupted", status: "running", observations: [], createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" })
    const list = store.list.bind(store)
    let ready = false
    store.open = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      ready = true
    })
    store.list = options => {
      if (!ready) throw new Error("Store is not open")
      return list(options)
    }
    const invocations = defineAgentInvocations({ store, storeTimeoutMs: 20 })

    const [recovered] = await Promise.all([
      recoverInterruptedAgentInvocations(invocations, { recover: () => true }),
      invocations.list(),
    ])

    expect(recovered).toBe(1)
    expect(store.open).toHaveBeenCalledOnce()
    await expect(invocations.get("interrupted")).resolves.toMatchObject({ status: "failed" })
  })

  it("propagates a rejected recovery open and retries before accessing the store", async () => {
    const store = createMemoryAgentInvocationStore()
    const list = vi.spyOn(store, "list")
    store.open = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Database unavailable"))
      .mockResolvedValue(undefined)
    const invocations = defineAgentInvocations({ store })

    await expect(recoverInterruptedAgentInvocations(invocations, { recover: () => true })).rejects.toThrow("Database unavailable")
    expect(list).not.toHaveBeenCalled()
    await expect(recoverInterruptedAgentInvocations(invocations, { recover: () => true })).resolves.toBe(0)
    await invocations.list()
    expect(store.open).toHaveBeenCalledTimes(2)
  })

  it("stops waiting for an open after 10 seconds", async () => {
    vi.useFakeTimers()
    const invocations = defineAgentInvocations({ store: lazyStore(() => new Promise(() => {})) })

    const list = invocations.list()
    const settled = expect(list).rejects.toThrow("store open timed out after 10000 ms")
    await vi.advanceTimersByTimeAsync(10_000)
    await settled
  })

  it.each(["resolve", "reject"] as const)("shares a timed-out open until it settles: %s", async (outcome) => {
    vi.useFakeTimers()
    const pending = deferred<void>()
    const open = vi.fn<() => Promise<void>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined)
    const list = vi.fn(() => ({ invocations: [] }))
    const invocations = defineAgentInvocations({ store: { ...createMemoryAgentInvocationStore(), list, open } })

    const first = expect(recoverInterruptedAgentInvocations(invocations, { recover: () => true })).rejects.toThrow("store open timed out after 10000 ms")
    await vi.advanceTimersByTimeAsync(10_000)
    await first

    const next = invocations.list()
    // A later caller gets a new wait bound, but must share the unfinished open.
    await vi.advanceTimersByTimeAsync(1)
    expect(open).toHaveBeenCalledOnce()
    expect(list).not.toHaveBeenCalled()
    if (outcome === "resolve") {
      pending.resolve()
      await expect(next).resolves.toMatchObject({ invocations: [] })
      await expect(invocations.list()).resolves.toMatchObject({ invocations: [] })
      expect(open).toHaveBeenCalledOnce()
    }
    else {
      const rejected = expect(next).rejects.toThrow("Database unavailable")
      pending.reject(new Error("Database unavailable"))
      await rejected
      await expect(invocations.list()).resolves.toMatchObject({ invocations: [] })
      expect(open).toHaveBeenCalledTimes(2)
    }
  })
})
