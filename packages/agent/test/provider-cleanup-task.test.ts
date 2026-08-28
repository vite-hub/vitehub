import { describe, expect, it } from "vitest"

import { settleAgentProviderCleanups } from "../src/internal/provider-cleanup-task.ts"

describe("Provider Agent cleanup retention", () => {
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
