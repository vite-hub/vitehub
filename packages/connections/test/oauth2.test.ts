import { describe, expect, it } from "vitest"

import { defineConnection } from "../src/definition.ts"
import { connect, createTestRuntime, testProvider } from "./helpers.ts"

describe("OAuth 2.0 through the typed runtime", () => {
  it("preserves endpoint parameters and overrides reserved flow parameters", async () => {
    const provider = { ...testProvider(), authorizationEndpoint: "https://auth.example.com/authorize?existing=1", authorizationParams: { prompt: "consent", state: "provider-state", client_id: "provider-client" } }
    const test = createTestRuntime(async () => ({ default: defineConnection({ provider, scopes: ["read", "write"] }) }))
    const flow = await test.runtime.authorize({ name: "mail", redirectUri: "https://app.example/cb" })
    const url = new URL(flow.url)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "client-id", code_challenge_method: "S256", existing: "1", prompt: "consent", redirect_uri: "https://app.example/cb", response_type: "code", scope: "openid read write", state: flow.state })
    expect(url.searchParams.get("code_challenge")).toBeTruthy()
  })

  it("resolves client credentials for the token exchange and form encodes them", async () => {
    const test = createTestRuntime(async () => ({ default: defineConnection({ provider: { ...testProvider(), clientId: () => "clïent id", clientSecret: () => "sécret:value" }, scopes: ["mail.modify"] }) }))
    await connect(test)
    const exchange = test.provider.calls.find(call => call.url === "https://auth.example.com/token")!
    expect(exchange.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toMatchObject({ client_id: "clïent id", client_secret: "sécret:value", code: "code-1", grant_type: "authorization_code" })
  })

  it("rejects a missing client id before contacting the provider", async () => {
    const test = createTestRuntime(async () => ({ default: defineConnection({ provider: { ...testProvider(), clientId: () => "" }, scopes: ["mail.modify"] }) }))
    await expect(test.runtime.authorize({ name: "mail", redirectUri: "https://app.example/cb" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls).toEqual([])
  })

  it.each(["invalid_grant", "invalid_client"])("maps %s without exposing the token response", async (error) => {
    const test = createTestRuntime()
    const flow = await test.runtime.authorize({ name: "mail", redirectUri: "https://app.example/cb" })
    test.provider.tokenResponses.push({ body: { error, secret: "upstream-secret" }, status: 400 })
    const failure: unknown = await test.runtime.complete({ code: "code", state: flow.state }).catch((reason: unknown) => reason)
    expect(failure).toMatchObject({ code: error === "invalid_grant" ? "CONNECTION_REAUTH_REQUIRED" : "CONNECTION_PROVIDER", details: { status: 400 } })
    expect(JSON.stringify(failure)).not.toContain("upstream-secret")
  })
})
