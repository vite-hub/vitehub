import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAgent, runAgent } from "../src/index.ts"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/server.ts"
import type { AgentInvocationStore } from "../src/server.ts"

const runtime = (runId: string) => ({ memo: vi.fn(), run: { runId }, runtime: "unknown" as const, waitUntil: () => {} })

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

    await expect(runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("first-run"), {})).resolves.toBe("done")
    await expect(invocations.getByRunId("first-run")).resolves.toMatchObject({ status: "completed" })
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

    await expect(runAgent(defineAgent({ driver: { run }, invocations, runtime: false }), runtime("initialized-run"), {})).resolves.toBe("done")
    expect(store.create).toHaveBeenCalledOnce()
    await expect(invocations.getByRunId("initialized-run")).resolves.toMatchObject({ status: "completed" })
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
    const pending = Promise.withResolvers<void>()
    const open = vi.fn<() => Promise<void>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(undefined)
    const list = vi.fn(() => ({ invocations: [] }))
    const invocations = defineAgentInvocations({ store: { ...createMemoryAgentInvocationStore(), list, open } })

    const first = expect(invocations.list()).rejects.toThrow("store open timed out after 10000 ms")
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
