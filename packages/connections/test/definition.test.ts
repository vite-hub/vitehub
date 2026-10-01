import { describe, expect, it } from "vitest"

import { defineConnection, isConnectionError } from "../src/index.ts"
import { fakeProvider } from "./helpers.ts"

import type { ConnectionAccess, ConnectionDefinition, ConnectionProvider } from "../src/types.ts"

function invalidPath(run: () => unknown): unknown {
  try {
    run()
  }
  catch (error) {
    expect(isConnectionError(error, "invalid")).toBe(true)
    return isConnectionError(error) ? error.details?.path : undefined
  }
  throw new Error("Expected defineConnection to throw.")
}

/** Builds a definition from untyped input, as a JavaScript caller could. */
function untyped(value: unknown): ConnectionDefinition {
  return value as ConnectionDefinition
}

describe("defineConnection", () => {
  it("returns the same definition when it is valid", () => {
    const { provider } = fakeProvider()
    const access: ConnectionAccess = {
      agents: { triage: { allow: ["gmail.messages.*"], approve: ["gmail.drafts.create"], deny: ["gmail.messages.trash"] } },
      routes: { "POST /api/labels/:id": { allow: ["gmail.labels.*"] } },
      server: { allow: ["*"] },
    }
    const definition = { access, description: "Inbox", provider }
    expect(defineConnection(definition)).toBe(definition)
    expect(defineConnection({ provider })).toEqual({ provider })
  })

  it("requires an OAuth 2 provider", () => {
    const { provider } = fakeProvider()
    expect(invalidPath(() => defineConnection(untyped(undefined)))).toBe("provider")
    expect(invalidPath(() => defineConnection(untyped({})))).toBe("provider")
    expect(invalidPath(() => defineConnection(untyped({ provider: { ...provider, kind: "api-key" } })))).toBe("provider")
  })

  it("rejects invalid access rules with the rule path", () => {
    const { provider } = fakeProvider()
    const define = (access: unknown) => () => defineConnection({ access: access as ConnectionAccess, provider })
    expect(invalidPath(define({ server: { allow: "gmail.*" } }))).toBe("access.server.allow")
    expect(invalidPath(define({ server: { deny: [""] } }))).toBe("access.server.deny")
    expect(invalidPath(define({ server: { approve: ["  "] } }))).toBe("access.server.approve")
    expect(invalidPath(define({ server: "all" }))).toBe("access.server")
    expect(invalidPath(define({ routes: { "GET /api": { allow: [1] } } }))).toBe("access.routes.GET /api.allow")
    expect(invalidPath(define({ agents: { triage: null } }))).toBe("access.agents.triage")
    expect(invalidPath(define({ agents: { triage: { deny: [null] } } }))).toBe("access.agents.triage.deny")
  })

  it("accepts a custom provider object with kind oauth2", () => {
    const provider: ConnectionProvider = {
      authorizationUrl: async () => "https://auth.example/authorize",
      exchange: async () => ({ accessToken: "token", scopes: [], tokenType: "Bearer" }),
      id: "custom",
      origins: ["https://api.example"],
      kind: "oauth2",
      refresh: async token => token,
      scopes: [],
    }
    expect(defineConnection({ provider }).provider.id).toBe("custom")
  })
})
