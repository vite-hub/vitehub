import { describe, expect, it, vi } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore, testProvider } from "./helpers.ts"

const invalidPolicies = [
  { access: null }, { access: false }, { access: "" }, { access: [] },
  { access: { server: null } }, { access: { server: [] } }, { access: { server: { read: "true" } } },
 { access: { server: { write: [null] } } },
  { access: { server: { approve: null } } },
  { api: null }, { api: false }, { api: "" }, { api: [] },
  { api: { mail: null } }, { api: { mail: "*" } }, { api: { mail: [null] } },
]

describe("Connection policy validation", () => {
  it.each(invalidPolicies)("rejects malformed JavaScript definition policies: %j", policy => {
    const definition = { provider: testProvider(), scopes: ["mail.read"], ...policy }
    expect(() => Reflect.apply(defineConnection, undefined, [definition])).toThrow()
  })

  it.each(invalidPolicies)("rejects malformed discovered definition policies before authorization: %j", async policy => {
    const fetch = vi.fn()
    const runtime = createConnectionsRuntime({
      definitions: { mail: async () => ({ default: { provider: testProvider(), scopes: ["mail.read"], ...policy } }) },
      fetch, store: createStore(),
    })
    await expect(runtime.authorize({ name: "mail", redirectUri: "http://localhost/callback" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([{}, { access: {}, api: {} }, { access: { server: { write: false } } }, { access: { server: {} }, api: { mail: undefined } }])("preserves valid omitted and restrictive policies: %j", policy => {
    const definition = { provider: testProvider(), scopes: ["mail.read"], ...policy }
    expect(Reflect.apply(defineConnection, undefined, [definition])).toBe(definition)
  })
})
