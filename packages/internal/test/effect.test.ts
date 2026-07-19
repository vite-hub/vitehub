import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { createEffectBoundary } from "../src/effect.ts"

const boundary = createEffectBoundary({
  aggregateMessage: "aggregate",
  interruptionMessage: "interrupted",
})

describe("Effect boundary", () => {
  it("preserves the caller's abort reason", async () => {
    const controller = new AbortController()
    const reason = new Error("stop")
    const result = boundary.run(Effect.never, { signal: controller.signal }).catch(error => error)
    controller.abort(reason)
    await expect(result).resolves.toBe(reason)
  })

  it("returns failures and defects by identity without FiberFailure", async () => {
    const failure = new Error("failure")
    const defect = new Error("defect")
    await expect(boundary.run(boundary.tryPromise("test", () => Promise.reject(failure))).catch(error => error))
      .resolves.toBe(failure)
    await expect(boundary.run(Effect.die(defect)).catch(error => error)).resolves.toBe(defect)
  })
})
