import { describe, expect, it, vi } from "vitest"

import { oauth2 } from "../src/providers/oauth2.ts"
import { expectCode, mockFetch, tokenSet } from "./helpers.ts"

import type { OAuth2ProviderOptions } from "../src/providers/oauth2.ts"

function options(overrides: Partial<OAuth2ProviderOptions> = {}): OAuth2ProviderOptions {
  return {
    authorizationUrl: "https://auth.example/authorize?existing=1",
    client: () => ({ clientId: "client id", clientSecret: { unseal: () => "secret:value" } }),
    origins: ["https://api.example", "https://auth.example"],
    scopes: ["read", "write"],
    tokenUrl: "https://auth.example/token",
    ...overrides,
  }
}

describe("oauth2", () => {
  it("validates required options", () => {
    expect(() => oauth2(options({ tokenUrl: "" }))).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID" }))
    expect(() => oauth2(options({ authorizationUrl: "" }))).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID" }))
    expect(() => oauth2(options({ scopes: [] }))).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID" }))
    expect(oauth2(options()).id).toBe("oauth2")
  })

  it("rejects authorization parameters that ViteHub sets for each flow", () => {
    for (const key of ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"]) {
      expect(() => oauth2(options({ authorizationParams: { [key]: "x" } }))).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID", details: { path: `provider.authorizationParams.${key}` } }))
    }
  })

  it("builds a PKCE authorization URL with extra parameters", async () => {
    const provider = oauth2(options({ authorizationParams: { prompt: "consent" } }))
    const url = new URL(await provider.authorizationUrl({ codeChallenge: "challenge", redirectUri: "https://app.example/cb", state: "state" }, { fetch: mockFetch(() => new Response(null)).fetch }))

    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client id",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      existing: "1",
      prompt: "consent",
      redirect_uri: "https://app.example/cb",
      response_type: "code",
      scope: "read write",
      state: "state",
    })
  })

  it("passes the event to the client resolver and rejects a missing client id", async () => {
    const client = vi.fn((_context: { event?: unknown }) => ({ clientId: "" }))
    const provider = oauth2(options({ client }))
    const event = { id: "event" }

    await expectCode(provider.authorizationUrl({ codeChallenge: "c", redirectUri: "r", state: "s" }, { event, fetch: mockFetch(() => new Response(null)).fetch }), "CONNECTIONS_INVALID")
    expect(client).toHaveBeenCalledWith({ event })
  })

  it.each([undefined, ""])("keeps Basic authentication with client secret %s", async (clientSecret) => {
    const upstream = mockFetch(() => Response.json({ access_token: "new" }))
    const provider = oauth2(options({
      client: () => ({ clientId: "client id", clientSecret }),
      clientAuth: "basic",
      revokeUrl: "https://auth.example/revoke",
    }))
    const context = { fetch: upstream.fetch }

    await provider.exchange({ code: "code", codeVerifier: "verifier", redirectUri: "https://app.example/cb" }, context)
    await provider.refresh(tokenSet(), context)
    await provider.revoke!(tokenSet(), context)

    expect(upstream.mock).toHaveBeenCalledTimes(3)
    for (const [, init] of upstream.mock.mock.calls) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${btoa("client+id:")}`)
      const body = new URLSearchParams(String(init?.body))
      expect(body.has("client_id")).toBe(false)
      expect(body.has("client_secret")).toBe(false)
    }
  })

  it("uses HTTP basic client authentication when configured", async () => {
    const upstream = mockFetch(() => Response.json({ access_token: "new", expires_in: "120" }))
    const provider = oauth2(options({ clientAuth: "basic" }))

    const token = await provider.exchange({ code: "code", codeVerifier: "verifier", redirectUri: "https://app.example/cb" }, { fetch: upstream.fetch })
    const call = upstream.mock.mock.calls[0]!
    const headers = new Headers(call[1]?.headers)
    // RFC 6749 form encoding: a space is `+`.
    expect(headers.get("authorization")).toBe(`Basic ${btoa("client+id:secret%3Avalue")}`)
    expect(upstream.calls[0]!.body).not.toContain("client_secret")
    expect(token).toMatchObject({ accessToken: "new", scopes: ["read", "write"], tokenType: "Bearer" })
    expect(token.expiresAt).toBeGreaterThan(Date.now())
  })

  it("encodes non-ASCII Basic credentials as UTF-8", async () => {
    const upstream = mockFetch(() => Response.json({ access_token: "new" }))
    const provider = oauth2(options({ client: () => ({ clientId: "clïent", clientSecret: "sécret" }), clientAuth: "basic" }))

    await provider.exchange({ code: "code", codeVerifier: "verifier", redirectUri: "https://app.example/cb" }, { fetch: upstream.fetch })
    expect(new Headers(upstream.mock.mock.calls[0]![1]?.headers).get("authorization")).toBe(`Basic ${btoa("cl%C3%AFent:s%C3%A9cret")}`)
  })

  it("keeps the previous refresh token, scopes, and account on refresh", async () => {
    const upstream = mockFetch(() => Response.json({ access_token: "rotated", token_type: "bearer" }))
    const provider = oauth2(options())
    const previous = tokenSet()

    const token = await provider.refresh(previous, { fetch: upstream.fetch })
    expect(new URLSearchParams(upstream.calls[0]!.body)).toEqual(new URLSearchParams({ grant_type: "refresh_token", refresh_token: previous.refreshToken!, client_id: "client id", client_secret: "secret:value" }))
    expect(token).toEqual({ account: previous.account, accessToken: "rotated", refreshToken: previous.refreshToken, scopes: previous.scopes, tokenType: "bearer" })
  })

  it("maps token endpoint errors without exposing the body", async () => {
    const provider = oauth2(options())
    const invalid = mockFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 }))
    const failed = mockFetch(() => new Response("upstream secret", { status: 500 }))

    await expectCode(provider.refresh(tokenSet(), { fetch: invalid.fetch }), "CONNECTIONS_NEEDS_RECONNECT")
    const error = await provider.refresh(tokenSet(), { fetch: failed.fetch }).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: "CONNECTIONS_PROVIDER_FAILED", details: { status: 500 } })
    expect(JSON.stringify(error)).not.toContain("upstream secret")
    await expectCode(provider.refresh(tokenSet({ refreshToken: undefined }), { fetch: invalid.fetch }), "CONNECTIONS_NEEDS_RECONNECT")
  })

  it("labels the account from user info", async () => {
    const upstream = mockFetch(url => url.pathname === "/token" ? Response.json({ access_token: "a", scope: "read,write" }) : Response.json({ login: "octo", sub: "1" }))
    const withSub = oauth2(options({ userInfoUrl: "https://auth.example/userinfo" }))
    const custom = oauth2(options({ account: info => typeof info.login === "string" ? info.login : undefined, userInfoUrl: "https://auth.example/userinfo" }))
    const input = { code: "c", codeVerifier: "v", redirectUri: "r" }

    expect(await withSub.exchange(input, { fetch: upstream.fetch })).toMatchObject({ account: "1", scopes: ["read", "write"] })
    expect(await custom.exchange(input, { fetch: upstream.fetch })).toMatchObject({ account: "octo" })
  })

  it("rejects a user info URL outside the provider origins", () => {
    expect(() => oauth2(options({ origins: ["https://api.example"], userInfoUrl: "https://auth.example/userinfo" })))
      .toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID", details: { path: "provider.userInfoUrl" } }))
  })

  it("accepts a 400 invalid_token revocation but fails other 400 errors", async () => {
    const upstream = mockFetch(() => Response.json({ error: "invalid_client" }, { status: 400 }))
    const provider = oauth2(options({ revokeUrl: "https://auth.example/revoke" }))
    await expectCode(provider.revoke!(tokenSet(), { fetch: upstream.fetch }), "CONNECTIONS_PROVIDER_FAILED")
    upstream.mock.mockImplementation(async () => Response.json({ error: "invalid_token" }, { status: 400 }))
    await expect(provider.revoke!(tokenSet(), { fetch: upstream.fetch })).resolves.toBeUndefined()
  })

  it("revokes the refresh token and accepts an already invalid token", async () => {
    const upstream = mockFetch(() => Response.json({ error: "invalid_token" }, { status: 400 }))
    const provider = oauth2(options({ revokeUrl: "https://auth.example/revoke" }))

    await provider.revoke!(tokenSet(), { fetch: upstream.fetch })
    expect(upstream.calls[0]).toMatchObject({ method: "POST", url: "https://auth.example/revoke" })
    expect(Object.fromEntries(new URLSearchParams(upstream.calls[0]!.body))).toEqual({
      client_id: "client id",
      client_secret: "secret:value",
      token: tokenSet().refreshToken,
      token_type_hint: "refresh_token",
    })
    upstream.mock.mockImplementation(async () => new Response(null, { status: 503 }))
    await expectCode(provider.revoke!(tokenSet(), { fetch: upstream.fetch }), "CONNECTIONS_PROVIDER_FAILED")
    expect(oauth2(options()).revoke).toBeUndefined()
  })

  it("authenticates the revocation request with HTTP basic when configured", async () => {
    const upstream = mockFetch(() => new Response(null, { status: 200 }))
    const provider = oauth2(options({ clientAuth: "basic", revokeUrl: "https://auth.example/revoke" }))

    await provider.revoke!(tokenSet({ refreshToken: undefined }), { fetch: upstream.fetch })
    expect(new Headers(upstream.mock.mock.calls[0]![1]?.headers).get("authorization")).toBe(`Basic ${btoa("client+id:secret%3Avalue")}`)
    expect(Object.fromEntries(new URLSearchParams(upstream.calls[0]!.body))).toEqual({ token: tokenSet().accessToken, token_type_hint: "access_token" })
  })
})
