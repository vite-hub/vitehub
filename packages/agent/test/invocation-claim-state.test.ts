import { afterEach, describe, expect, it, vi } from "vitest"

import { agentInvocationClaimState, createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

async function journal() {
  const store = createMemoryAgentInvocationStore()
  const timestamp = new Date().toISOString()
  await store.create({ createdAt: timestamp, id: "turn", observations: [], status: "running", traceId: "turn", updatedAt: timestamp })
  return { invocations: defineAgentInvocations({ store, storeTimeoutMs: 10 }), store }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("Invocation claim probes", () => {
  it("distinguishes missing, held and free claims without retaining a probe claim", async () => {
    const { invocations, store } = await journal()
    await expect(agentInvocationClaimState(invocations, "missing")).resolves.toBe("missing")
    expect(await store.claim("turn", "live-owner", 30_000)).toBe(true)
    await expect(agentInvocationClaimState(invocations, "turn")).resolves.toBe("held")
    await store.release("turn", "live-owner")
    await expect(agentInvocationClaimState(invocations, "turn")).resolves.toBe("free")
    expect(await store.claim("turn", "next-owner", 30_000)).toBe(true)
  })

  it.each(["getSummary", "claim", "release"] as const)("bounds a pending %s operation by storeTimeoutMs", async (operation) => {
    const { invocations, store } = await journal()
    vi.useFakeTimers()
    vi.spyOn(store, operation).mockImplementation(() => new Promise<never>(() => {}))
    let outcome: unknown
    void agentInvocationClaimState(invocations, "turn").then(value => { outcome = value }, error => { outcome = error })

    await vi.advanceTimersByTimeAsync(100)
    expect(outcome).toBeInstanceOf(Error)
    expect(String(outcome)).toContain("store operation timed out after 10 ms")
  })

  it("releases a claim that is acquired after its probe times out", async () => {
    const { invocations, store } = await journal()
    vi.useFakeTimers()
    let finishClaim!: () => void
    const gate = new Promise<void>(resolve => { finishClaim = resolve })
    const claim = store.claim
    vi.spyOn(store, "claim").mockImplementation(async (...args) => {
      await gate
      return claim(...args)
    })
    const release = vi.spyOn(store, "release")
    const failed = expect(agentInvocationClaimState(invocations, "turn")).rejects.toThrow("store operation timed out after 10 ms")
    await vi.advanceTimersByTimeAsync(10)
    await failed

    finishClaim()
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledWith("turn", expect.stringMatching(/^probe_/))
    expect(await claim("turn", "next-owner", 30_000)).toBe(true)
  })
})
