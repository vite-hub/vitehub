import { describe, expect, it } from "vitest"

import { defineChannel } from "../src/index.ts"

const connector = {
  async send() {
    return { id: "delivery-1" }
  },
}

describe("defineChannel", () => {
  it("keeps connector definitions intact", () => {
    const definition = { connectors: { fixture: connector } }
    expect(defineChannel(definition)).toBe(definition)
  })

  it("keeps Env-backed resolver definitions intact", () => {
    const resolver = () => ({ connectors: { fixture: connector } })
    expect(defineChannel(resolver)).toBe(resolver)
  })

  it.each([
    [{}, "connectors"],
    [{ connectors: {} }, "at least one"],
    [{ connectors: { fixture: {} } }, "send"],
    [{ connectors: { fixture: connector }, defaultConnector: "missing" }, "not configured"],
  ])("rejects invalid definitions", (definition, message) => {
    expect(() => defineChannel(definition as never)).toThrow(message)
  })
})
