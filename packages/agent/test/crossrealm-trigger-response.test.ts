import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { resolveAgentTriggerInvocationResult } from "../src/trigger-runtime.ts"

describe("agent trigger cross realm responses", () => {
  it("preserves a Response returned by another realm", () => {
    const foreignResponse = runInNewContext(`class ForeignResponse {
      get [Symbol.toStringTag]() { return "Response" }
    }
    new ForeignResponse()`)
    expect(foreignResponse).not.toBeInstanceOf(Response)
    const trigger = {} as never
    const result = resolveAgentTriggerInvocationResult(foreignResponse as never, trigger)
    expect(result).toMatchObject({ response: foreignResponse })
  })
})
