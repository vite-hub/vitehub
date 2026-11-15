import { describe, expect, it, vi } from "vitest"

import { defineChannel, stripe, webhook } from "../src/index.ts"
import { isChannelDefinition } from "../src/definition.ts"

describe("defineChannel", () => {
  it("keeps the adapter and targets and marks the result", () => {
    const send = vi.fn(() => ({ id: "message-1" }))
    const handler = vi.fn()
    const adapter = { kind: "alerts", send }
    const definition = defineChannel({ adapter, on: {} })

    expect(definition.adapter).toBe(adapter)
    expect(isChannelDefinition(definition)).toBe(true)
    expect(isChannelDefinition({ adapter })).toBe(false)
    expect(Object.keys(defineChannel({ adapter: stripe(), on: { "checkout.session.completed": handler } }))).toEqual(["adapter", "on"])
  })

  it("accepts handlers next to triggers on an HTTP sender", () => {
    const trigger = { invoke: () => new Response(null) }
    expect(() => defineChannel({ adapter: webhook({ secret: false }), on: { webhook: () => undefined, record: trigger } })).not.toThrow()
  })

  it.each([
    [undefined, "CHANNELS_C0001"],
    [{}, "CHANNELS_C0007"],
    [{ adapter: { kind: "" } }, "CHANNELS_C0007"],
    [{ adapter: { kind: "alerts", send: "nope" } }, "CHANNELS_C0008"],
    [{ adapter: webhook({ secret: false }), on: [] }, "CHANNELS_C0009"],
    [{ adapter: webhook({ secret: false }), on: { "": () => undefined } }, "CHANNELS_C0009"],
    [{ adapter: webhook({ secret: false }), on: { webhook: {} } }, "CHANNELS_C0009"],
    [{ adapter: { kind: "slack", send: () => ({}) }, on: { message: () => undefined } }, "CHANNELS_C0010"],
  ])("rejects an invalid definition with %#", (definition, code) => {
    expect(() => defineChannel(definition as never)).toThrowError(expect.objectContaining({ code }))
  })

  it.each([
    [{}, "has no `signature` and no `secret`"],
    [{ secret: "token" }, "has a `secret` but no `signature`"],
    [{ secret: () => "token" }, "has a `secret` but no `signature`"],
    [{ signature: "bearer" }, "has a `signature` but no `secret`"],
    [{ signature: "bearer", secret: false }, "sets `secret: false` and a `signature`"],
    [{ signature: "token", secret: "token" }, "needs a `header`"],
  ])("rejects a webhook adapter that does not verify with %j", (options, message) => {
    const adapter = { kind: "webhook", webhook: options }
    expect(() => defineChannel({ adapter, on: { webhook: () => undefined } }))
      .toThrowError(expect.objectContaining({ code: "CHANNELS_C0011", message: expect.stringContaining(message) }))
  })

  it("accepts a signed webhook adapter, and an unsigned one only with `secret: false`", () => {
    expect(() => defineChannel({ adapter: webhook({ signature: "bearer", secret: "token" }) })).not.toThrow()
    expect(() => defineChannel({ adapter: webhook({ signature: "token", header: "x-gitlab-token", secret: () => "token" }) })).not.toThrow()
    expect(() => defineChannel({ adapter: webhook({ secret: false }) })).not.toThrow()
  })
})

describe("webhook adapters", () => {
  it("builds a generic webhook adapter", () => {
    const event = (payload: { kind: string }) => payload.kind
    expect(webhook({ kind: "airtable", path: "/api/airtable/webhook", signature: "bearer", secret: "token", event })).toEqual({
      kind: "airtable",
      webhook: { path: "/api/airtable/webhook", signature: "bearer", secret: "token", event },
    })
    expect(webhook({ secret: false })).toEqual({ kind: "webhook", webhook: { secret: false } })
  })

  it("reads the Stripe event type and ID", () => {
    const adapter = stripe({ secret: "whsec_test", stateScope: "webhook:support:stripe:stripe:" })
    const payload = { id: "evt_1", type: "checkout.session.completed" }
    const request = { headers: {}, method: "POST", url: "https://example.com" }
    expect(adapter.kind).toBe("stripe")
    expect(adapter.webhook).toMatchObject({ secret: "whsec_test", signature: "stripe-sha256", stateScope: "webhook:support:stripe:stripe:" })
    expect(adapter.webhook.event?.(payload as never, request)).toBe("checkout.session.completed")
    expect(adapter.webhook.id?.(payload as never, request)).toBe("evt_1")
    expect(stripe({ toleranceSeconds: 60 }).webhook.signature).toEqual({ preset: "stripe-sha256", toleranceSeconds: 60 })
  })

  it("reads STRIPE_WEBHOOK_SECRET by default", () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_env")
    try {
      const secret = stripe().webhook.secret
      expect(typeof secret === "function" ? secret() : secret).toBe("whsec_env")
    }
    finally {
      vi.unstubAllEnvs()
    }
  })
})
