import { describe, expect, it } from "vitest"

import { defineChannel, defineOutboundChannel } from "../src/index.ts"

const connector = {
  async send() {
    return { id: "delivery-1" }
  },
}

describe("defineOutboundChannel", () => {
  it("keeps connector definitions intact", () => {
    const definition = { connectors: { fixture: connector } }
    expect(defineOutboundChannel(definition)).toBe(definition)
  })

  it.each([
    [{}, "connectors"],
    [{ connectors: {} }, "at least one"],
    [{ connectors: { fixture: {} } }, "send"],
    [{ connectors: { fixture: connector }, defaultConnector: "missing" }, "not configured"],
  ])("rejects invalid definitions", (definition, message) => {
    expect(() => defineOutboundChannel(definition as never)).toThrow(message)
  })
})

describe("defineChannel", () => {
  it("remains a deprecated alias of defineOutboundChannel", () => {
    const definition = { connectors: { fixture: connector } }
    expect(defineChannel).toBe(defineOutboundChannel)
    expect(defineChannel(definition)).toBe(definition)
    expect(() => defineChannel({ connectors: {} } as never)).toThrow("at least one")
  })
})
