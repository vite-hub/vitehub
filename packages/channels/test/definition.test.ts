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
    [{ connectors: { "": connector } }, "non-empty"],
    [{ connectors: { fixture: {} } }, "send"],
    [{ connectors: { fixture: connector }, defaultConnector: "missing" }, "not configured"],
  ])("rejects invalid definitions", (definition, message) => {
    expect(() => defineOutboundChannel(definition as never)).toThrow(message)
  })

  it.each([
    { get broken() { throw new Error("connector getter failed") } },
    { broken: { get send() { throw new Error("send getter failed") } } },
  ])("turns throwing connector reads into the connector diagnostic", (connectors) => {
    expect(() => defineOutboundChannel({ connectors } as never)).toThrowError(expect.objectContaining({
      code: "CHANNELS_C0004",
      message: 'Channel connector "broken" must expose a send function.',
    }))
  })

  it.each([
    [{ connectors: { "": connector }, defaultConnector: "" }, "CHANNELS_C0006"],
    [{ connectors: { fixture: {} } }, "CHANNELS_C0004"],
  ])("distinguishes connector name and implementation diagnostics", (definition, code) => {
    expect(() => defineOutboundChannel(definition as never)).toThrowError(expect.objectContaining({ code }))
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
