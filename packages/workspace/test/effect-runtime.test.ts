import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

import {
  runWorkspaceEffect,
  tryWorkspacePromise,
  WorkspaceEffectFailure,
} from "../src/internal/effect-runtime.ts"

describe("workspace Effect runtime", () => {
  it("preserves defects even when they resemble the typed failure wrapper", async () => {
    const cause = new Error("provider failed")
    const defect = new WorkspaceEffectFailure({ cause, operation: "workspace.test" })

    await expect(runWorkspaceEffect(Effect.die(defect))).rejects.toBe(defect)
  })

  it("keeps expected Promise failures in the typed failure channel", async () => {
    const cause = new Error("provider failed")
    const effect = tryWorkspacePromise("workspace.test", () => Promise.reject(cause))
    const exit = await Effect.runPromiseExit(effect)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(exit.cause.reasons).toHaveLength(1)
    const [reason] = exit.cause.reasons
    expect(Cause.isFailReason(reason)).toBe(true)
    if (!Cause.isFailReason(reason)) return
    expect(reason.error).toBeInstanceOf(WorkspaceEffectFailure)
    expect(reason.error.cause).toBe(cause)
    await expect(runWorkspaceEffect(effect)).rejects.toBe(cause)
  })
})
