import { describe, expect, it, vi } from "vitest"

import { createAgentProviderCredentialCleanup, settleAgentProviderCleanups } from "../src/internal/provider-cleanup-task.ts"

describe("Provider Agent cleanup retention", () => {
  it("force-removes credentials without waiting for stalled persistence", async () => {
    let finishPersistence!: () => void
    const persistence = new Promise<void>(resolve => finishPersistence = resolve)
    const persist = vi.fn(() => persistence)
    const remove = vi.fn(async () => undefined)
    const cleanup = createAgentProviderCredentialCleanup(persist, remove)

    const pending = cleanup.cleanup()
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    await expect(cleanup.forceRemove()).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledOnce()

    finishPersistence()
    await expect(pending).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledOnce()
  })

  it("releases credential custody when removal fails", async () => {
    const failure = new Error("credential removal failed")
    const release = vi.fn()
    const cleanup = createAgentProviderCredentialCleanup(
      async () => undefined,
      async () => { throw failure },
      release,
    )

    await expect(cleanup.forceRemove()).rejects.toBe(failure)
    expect(release).toHaveBeenCalledOnce()
    await expect(cleanup.forceRemove()).rejects.toBe(failure)
    expect(release).toHaveBeenCalledOnce()
  })

  it("waits for every cleanup before propagating a failure", async () => {
    const failure = new Error("credential cleanup failed")
    let finishRootCleanup!: () => void
    const rootCleanup = new Promise<void>(resolve => finishRootCleanup = resolve)
    const cleanup = settleAgentProviderCleanups([Promise.reject(failure), rootCleanup])
    let settled = false
    void cleanup.catch(() => settled = true)

    await Promise.resolve()
    expect(settled).toBe(false)

    finishRootCleanup()
    await expect(cleanup).rejects.toBe(failure)
  })

  it("preserves every failure after all cleanups settle", async () => {
    const credentialFailure = new Error("credential cleanup failed")
    const rootFailure = new Error("root cleanup failed")

    await expect(settleAgentProviderCleanups([
      Promise.reject(credentialFailure),
      Promise.reject(rootFailure),
    ])).rejects.toMatchObject({
      errors: [credentialFailure, rootFailure],
    })
  })
})
