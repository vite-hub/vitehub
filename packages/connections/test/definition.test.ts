import { expect, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore, testProvider } from "./helpers.ts"

import type { ConnectionOAuthDefinition } from "../src/types.ts"

it("preserves the typed provider and explicit actor access definition", () => {
  const definition = { access: { "agent:triage": { read: true, write: ["mail.messages.modify"] as const } }, api: { mail: ["messages.modify"] as const }, provider: testProvider(), scopes: ["mail.modify"] }
  expect(defineConnection(definition)).toBe(definition)
})

it("accepts a provider mcp endpoint only when it can carry a credential", async () => {
  const definition = defineConnection({ provider: { ...testProvider(), mcp: "https://mcp.example.com/mcp" }, scopes: [] }) as ConnectionOAuthDefinition
  const runtime = createConnectionsRuntime({ definitions: { mail: definition }, store: createStore() })
  expect(await runtime.inspect("mail")).toMatchObject({ mcp: "https://mcp.example.com/mcp" })
  for (const mcp of ["http://mcp.example.com/mcp", "https://mcp.example.com/mcp?token=1", "https://user@mcp.example.com/mcp"]) {
    expect(() => defineConnection({ provider: { ...testProvider(), mcp }, scopes: [] })).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID_DEFINITION" }))
  }
})

it("rejects unsafe API catalog roots in login definitions", () => {
  expect(() => defineConnection({
    provider: {
      account: () => undefined,
      apis: { mail: { methods: {}, rootUrl: "https://user:password@example.com/" } },
      id: "login",
      kind: "oauth-login",
      login: async () => "http://127.0.0.1/callback",
      mcp: "https://mcp.example.com/mcp",
      origins: [],
      redirectUri: "http://127.0.0.1/callback",
    },
  })).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID_DEFINITION" }))
})

it("does not validate an overlapping login provider as OAuth", () => {
  expect(() => defineConnection({
    provider: {
      account: () => undefined,
      apis: { mail: { methods: {}, rootUrl: "https://user:password@example.com/" } },
      authorizationEndpoint: "https://auth.example.com/authorize",
      clientId: "client-id",
      id: "login",
      kind: "oauth-login",
      login: async () => "http://127.0.0.1/callback",
      mcp: "https://mcp.example.com/mcp",
      origins: [],
      redirectUri: "http://127.0.0.1/callback",
      tokenEndpoint: "https://auth.example.com/token",
    },
  })).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID_DEFINITION" }))
})
