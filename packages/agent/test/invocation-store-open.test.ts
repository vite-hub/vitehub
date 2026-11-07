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
})
