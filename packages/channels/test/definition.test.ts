import { describe, expect, it } from "vitest"

import { defineOutboundChannel } from "../src/index.ts"

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

  it("turns a throwing connectors getter into the connectors diagnostic", () => {
    const definition = { get connectors() { throw new Error("connectors getter failed") } }
    expect(() => defineOutboundChannel(definition as never)).toThrowError(expect.objectContaining({
      code: "CHANNELS_C0002",
    }))
  })

  it("turns a revoked connectors proxy into the connectors diagnostic", () => {
    const { proxy, revoke } = Proxy.revocable({ broken: connector }, {})
    revoke()
    expect(() => defineOutboundChannel({ connectors: proxy } as never)).toThrowError(expect.objectContaining({
      code: "CHANNELS_C0002",
    }))
  })

  it.each([
    Symbol("missing"),
    { toString() { throw new Error("default connector formatting failed") } },
  ])("turns an unrepresentable default connector into the default connector diagnostic", (defaultConnector) => {
    expect(() => defineOutboundChannel({ connectors: { fixture: connector }, defaultConnector } as never)).toThrowError(expect.objectContaining({
      code: "CHANNELS_C0005",
    }))
  })

  it.each([
    [{ connectors: { "": connector }, defaultConnector: "" }, "CHANNELS_C0006"],
    [{ connectors: { fixture: {} } }, "CHANNELS_C0004"],
  ])("distinguishes connector name and implementation diagnostics", (definition, code) => {
    expect(() => defineOutboundChannel(definition as never)).toThrowError(expect.objectContaining({ code }))
  })
})
