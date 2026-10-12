import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { resolveAgentTriggerInvocationResult } from "../src/trigger-runtime.ts"

describe("agent trigger cross realm responses", () => {
  it("preserves a Response returned by another realm", () => {
    const foreignResponse = runInNewContext(`new class {
      headers = {}
      body = null
      status = 200
      statusText = "OK"
      ok = true
      redirected = false
      url = ""
      clone() { return this }
      arrayBuffer() { return Promise.resolve(new ArrayBuffer(0)) }
      blob() { return Promise.resolve({}) }
      formData() { return Promise.resolve({}) }
      json() { return Promise.resolve(null) }
      text() { return Promise.resolve("foreign") }
    }()`)
    const trigger = {} as never
    const result = resolveAgentTriggerInvocationResult(foreignResponse as never, trigger)
    expect(result).toMatchObject({ response: foreignResponse })
  })

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
