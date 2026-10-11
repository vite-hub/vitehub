import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { resolveAgentTriggerInvocationResult } from "../src/trigger-runtime.ts"

describe("agent trigger cross realm responses", () => {
  it("rejects a Symbol.toStringTag impostor", () => {
    const impostor = runInNewContext(`({ input: { context: {} }, [Symbol.toStringTag]: "Response" })`)
    const trigger = {} as never
    const result = resolveAgentTriggerInvocationResult(impostor as never, trigger)
    expect(result).toMatchObject({ input: impostor })
    expect(result).not.toHaveProperty("response")
  })

  it("rejects values with hostile Symbol.toStringTag accessors", () => {
    const hostile = runInNewContext(`Object.defineProperty({ input: { context: {} } }, Symbol.toStringTag, {
      get() { throw new Error("hostile") }
    })`)
    const trigger = {} as never
    expect(() => resolveAgentTriggerInvocationResult(hostile as never, trigger)).not.toThrow()
  })
})
