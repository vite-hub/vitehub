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

it("needs a client id and both endpoints unless the provider has an mcp endpoint", () => {
  expect(() => defineConnection({ provider: { id: "portal", mcp: "https://acme.example.com/mcp" }, scopes: [] })).not.toThrow()
  // SAFETY: JavaScript callers can leave out what the types require.
  const incomplete = { id: "crm", authorizationEndpoint: "https://crm.example.com/authorize", tokenEndpoint: "https://crm.example.com/token" } as unknown as ConnectionOAuthDefinition["provider"]
  expect(() => defineConnection({ provider: incomplete, scopes: [] })).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID_DEFINITION" }))
})
