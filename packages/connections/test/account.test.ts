import { describe, expect, it } from "vitest"

import { accountFromIdToken, providerAccount } from "../src/account.ts"
import { defineConnection } from "../src/definition.ts"
import { connect, createTestRuntime } from "./helpers.ts"

import type { ConnectionProvider } from "../src/types.ts"

function base64Url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function idToken(claims: unknown): string {
  return `${base64Url(JSON.stringify({ alg: "RS256" }))}.${base64Url(JSON.stringify(claims))}.signature`
}

function oidcProvider(overrides: Partial<ConnectionProvider> = {}): ConnectionProvider {
  return {
    authorizationEndpoint: "https://auth.example.com/authorize",
    clientId: "client-id",
    id: "example",
    identityScopes: ["openid", "email"],
    tokenEndpoint: "https://auth.example.com/token",
    ...overrides,
  }
}

describe("OpenID Connect account default", () => {
  it("reads sub and email from the ID token", () => {
    const response = { access_token: "access", id_token: idToken({ sub: "account-1", email: "owner@example.com", aud: "client-id" }) }
    expect(providerAccount(oidcProvider(), response)).toEqual({ id: "account-1", email: "owner@example.com" })
  })

  it("reads sub without email", () => {
    expect(providerAccount(oidcProvider(), { access_token: "access", id_token: idToken({ sub: "account-1" }) })).toEqual({ id: "account-1" })
    expect(providerAccount(oidcProvider(), { access_token: "access", id_token: idToken({ sub: "account-1", email: 42 }) })).toEqual({ id: "account-1" })
  })

  it("decodes base64url payloads with URL-safe characters and no padding", () => {
    const email = "é?>>~~@example.com"
    expect(accountFromIdToken(idToken({ sub: "ü>?", email }))).toEqual({ id: "ü>?", email })
  })

  it("uses an explicit account function first", () => {
    const provider = oidcProvider({ account: () => ({ id: "explicit" }) })
    expect(providerAccount(provider, { access_token: "access", id_token: idToken({ sub: "account-1" }) })).toEqual({ id: "explicit" })
  })

  it("gives no account without openid or an account function", () => {
    const provider = oidcProvider({ identityScopes: ["email"] })
    expect(providerAccount(provider, { access_token: "access", id_token: idToken({ sub: "account-1" }) })).toBeUndefined()
    expect(providerAccount(oidcProvider({ identityScopes: undefined }), { access_token: "access", id_token: idToken({ sub: "account-1" }) })).toBeUndefined()
  })

  it("gives no account for a missing or malformed ID token", () => {
    for (const token of [undefined, "", "invalid", "header..signature", "header.!!!.signature", `header.${base64Url("not json")}.signature`]) {
      expect(providerAccount(oidcProvider(), { access_token: "access", id_token: token })).toBeUndefined()
    }
    for (const claims of [null, [], "account-1", { email: "owner@example.com" }, { sub: 42 }]) {
      expect(providerAccount(oidcProvider(), { access_token: "access", id_token: idToken(claims) })).toBeUndefined()
    }
  })
})

describe("OAuth provider without account or apis", () => {
  it("connects and stores the ID token account", async () => {
    const definition = defineConnection({ provider: oidcProvider(), scopes: ["profile"] })
    const test = createTestRuntime(definition)
    await connect(test, { id_token: idToken({ sub: "account-1", email: "owner@example.com" }) })
    const inspection = await test.runtime.inspect("mail")
    expect(inspection).toMatchObject({ account: { id: "account-1", email: "owner@example.com" }, actions: [], status: "connected" })
    expect(new URL(test.provider.calls[0]!.url).origin).toBe("https://auth.example.com")
  })

  it("quarantines a reconnect that does not identify the account", async () => {
    const test = createTestRuntime(defineConnection({ provider: oidcProvider(), scopes: [] }))
    await connect(test, { id_token: idToken({ sub: "account-1" }) })
    await expect(connect(test, { id_token: "invalid" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(await test.runtime.inspect("mail")).toMatchObject({ account: { id: "account-1" }, status: "reauth_required" })
  })

  it("rejects requests to any origin because it has no API catalogs", async () => {
    const test = createTestRuntime(defineConnection({ provider: oidcProvider(), scopes: [] }))
    await connect(test, { id_token: idToken({ sub: "account-1" }) })
    const before = test.provider.calls.length
    await expect(test.runtime.client("mail", {}).fetch("https://auth.example.com/userinfo")).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls).toHaveLength(before)
  })
})
