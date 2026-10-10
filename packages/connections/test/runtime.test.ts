import { describe, expect, it, vi } from "vitest"
import { agentEnvAccess } from "../../env/test/agent-access.ts"

import { isConnectionError } from "../src/errors.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { ACCESS_TOKEN, CLIENT_SECRET, connect, createStore, createTestRuntime, mailConnection, REFRESH_TOKEN, testProvider } from "./helpers.ts"

import type { ConnectionEffect, UseConnectionOptions } from "../src/types.ts"

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  }
  catch (error) {
    return error
  }
  throw new Error("Expected the promise to reject.")
}

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

describe("connect", () => {
  it("rejects oversized custom names before provider token exchange", async () => {
    const test = createTestRuntime()
    const name = "n".repeat(502)
    const runtime = createConnectionsRuntime({ definitions: { [name]: mailConnection() }, fetch: test.provider.fetch, store: test.store })
    expect(await rejection(runtime.authorize({ name, redirectUri: "http://localhost/callback" }))).toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls).toHaveLength(0)
  })

  it.each(["rejected", "invalid"])("retries unsuccessful definition loaders (%s)", async (failure) => {
    let calls = 0
    const loader = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        if (failure === "rejected") throw new Error("Module temporarily unavailable")
        return { default: {} }
      }
      return { default: mailConnection() }
    })
    const test = createTestRuntime(loader)
    await expect(test.runtime.inspect("mail")).rejects.toThrow()
    expect(await test.runtime.inspect("mail")).toMatchObject({ name: "mail", status: "disconnected" })
    await test.runtime.inspect("mail")
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it("builds a PKCE authorization URL and stores the exchanged token", async () => {
    const test = createTestRuntime()
    const { state, url } = await test.runtime.authorize({ name: "mail", redirectUri: "http://127.0.0.1:8976/callback" })
    const authorization = new URL(url)
    expect(authorization.origin + authorization.pathname).toBe("https://auth.example.com/authorize")
    expect(authorization.searchParams.get("scope")).toBe("openid mail.modify")
    expect(authorization.searchParams.get("access_type")).toBe("offline")
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorization.searchParams.get("state")).toBe(state)

    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600, id_token: "account-1", refresh_token: REFRESH_TOKEN, scope: "openid mail.modify" } })
    const connection = await test.runtime.complete({ code: "code-1", state })
    expect(connection).toMatchObject({ account: { email: "owner@example.com", id: "account-1" }, scopes: { missing: [] }, status: "connected" })

    const exchange = new URLSearchParams(test.provider.calls.at(-1)!.body)
    expect(exchange.get("grant_type")).toBe("authorization_code")
    expect(exchange.get("redirect_uri")).toBe("http://127.0.0.1:8976/callback")
    const challenge = base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.get("code_verifier")!)))
    expect(challenge).toBe(authorization.searchParams.get("code_challenge"))

    // A state is single use.
    expect(await rejection(test.runtime.complete({ code: "code-1", state }))).toMatchObject({ code: "CONNECTION_INVALID" })
  })

  it("rejects redirect URIs that are not HTTPS or loopback", async () => {
    const test = createTestRuntime()
    expect(await rejection(test.runtime.authorize({ name: "mail", redirectUri: "http://example.com/callback" }))).toMatchObject({ code: "CONNECTION_INVALID" })
  })

  it("retains the refresh grant when the same account authorizes again", async () => {
    const test = createTestRuntime()
    await connect(test)
    await connect(test, { refresh_token: undefined, expires_in: 1 })
    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600 } })
    await test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })
    const refresh = test.provider.calls.find(call => call.body?.includes("grant_type=refresh_token"))
    expect(new URLSearchParams(refresh?.body).get("refresh_token")).toBe(REFRESH_TOKEN)
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected", account: { id: "account-1" } })
  })

  it("quarantines an unidentified replacement grant without clearing the account", async () => {
    const test = createTestRuntime()
    await connect(test)
    // Model a provider consuming the existing grant while issuing the rejected account token.
    test.provider.valid.delete(ACCESS_TOKEN)
    await expect(connect(test, { id_token: undefined, access_token: "unknown-access", refresh_token: "unknown-refresh" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls.filter(call => call.url === "https://auth.example.com/revoke")).toHaveLength(0)
    expect(await test.runtime.inspect("mail")).toMatchObject({ account: { id: "account-1" }, status: "reauth_required" })
    expect(JSON.parse((await test.store.secrets.read("connection/mail"))!.value)).toMatchObject({ accessToken: ACCESS_TOKEN, accountId: "account-1" })
    await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  })

  it("reports reduced scopes returned during a token refresh", async () => {
    const test = createTestRuntime()
    await connect(test, { expires_in: 1 })
    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600, scope: "openid" } })
    await test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })
    expect(await test.runtime.inspect("mail")).toMatchObject({ scopes: { granted: ["openid"], missing: ["mail.modify"] } })
  })

  it("waits for a failed refresh to settle before reconnecting", async () => {
    const test = createTestRuntime()
    await connect(test, { expires_in: 1 })
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const release = new Promise<void>(resolve => { resume = resolve })
    const request = test.provider.fetch
    test.runtime = createConnectionsRuntime({ definitions: { mail: mailConnection() }, store: test.store, now: () => test.now.value, fetch: async (input, init) => {
      if (String(init?.body).includes("grant_type=refresh_token")) {
        enter()
        await release
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      return await request(input, init)
    } })
    const call = test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })
    const failed = expect(call).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    await entered
    const reconnecting = connect(test)
    resume()
    await failed
    await reconnecting
    await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).resolves.toMatchObject({ labels: [{ id: "INBOX" }] })
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" })
  })

  it("waits for the winning refresh without sending another refresh grant", async () => {
    const test = createTestRuntime()
    await connect(test, { expires_in: 1 })
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const release = new Promise<void>(resolve => { resume = resolve })
    const options = { definitions: { mail: mailConnection() }, store: test.store, now: () => test.now.value }
    const winner = createConnectionsRuntime({ ...options, fetch: async (input, init) => {
      if (String(init?.body).includes("grant_type=refresh_token")) {
        enter()
        await release
        return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600 })
      }
      return await test.provider.fetch(input, init)
    } })
    let duplicateRefreshes = 0
    const loser = createConnectionsRuntime({ ...options, fetch: async (input, init) => {
      if (String(init?.body).includes("grant_type=refresh_token")) {
        duplicateRefreshes++
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      return await test.provider.fetch(input, init)
    } })
    const call = winner.client("mail", {}).call("mail.labels.list", { userId: "me" })
    await entered
    const waiting = loser.client("mail", {}).call("mail.labels.list", { userId: "me" })
    await new Promise(resolve => setTimeout(resolve, 50))
    resume()
    await expect(waiting).resolves.toMatchObject({ labels: [{ id: "INBOX" }] })
    await call
    expect(duplicateRefreshes).toBe(0)
    expect(await winner.inspect("mail")).toMatchObject({ status: "connected" })
  })

  it("does not resurrect state when revocation follows token replacement", async () => {
    const test = createTestRuntime()
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const release = new Promise<void>(resolve => { resume = resolve })
    const put = test.store.state.putForToken
    test.store.state.putForToken = async (state, revision) => {
      if (state.status === "connected") { enter(); await release }
      return await put(state, revision)
    }
    const callback = connect(test)
    await entered
    const revoking = test.runtime.revoke({ name: "mail" })
    resume()
    await callback
    await revoking
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "revoked" })
    await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  })

  it("waits for refresh persistence before revoking the replacement token", async () => {
    const definition = mailConnection()
    const test = createTestRuntime(definition)
    await connect(test, { expires_in: 1 })
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const release = new Promise<void>(resolve => { resume = resolve })
    const put = test.store.state.putForToken
    test.store.state.putForToken = async (state, revision) => {
      if (state.status === "connected") { enter(); await release }
      return await put(state, revision)
    }
    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600 } })
    const call = test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })
    await entered
    const revoking = test.runtime.revoke({ name: "mail" })
    resume()
    await Promise.allSettled([call])
    await revoking
    await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "revoked" })
  })

  it("rejects revocation when the provider has no revocation endpoint", async () => {
    const definition = mailConnection()
    const test = createTestRuntime({ ...definition, provider: { ...definition.provider, revocationEndpoint: undefined } })
    await connect(test)
    await expect(test.runtime.revoke({ name: "mail" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" })
    await test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })
  })

  it("serializes concurrent callbacks without revoking either provider grant", async () => {
    const test = createTestRuntime()
    const providerFetch = test.provider.fetch
    test.provider.valid.add("access-one")
    test.provider.valid.add("access-two")
    test.provider.fetch = async (...args) => {
      const response = await providerFetch(...args)
      // Some providers revoke the entire application grant, including the winning token.
      if (String(args[0]) === "https://auth.example.com/revoke") test.provider.valid.clear()
      return response
    }
    test.runtime = createConnectionsRuntime({ definitions: { mail: mailConnection() }, store: test.store, fetch: test.provider.fetch, now: () => test.now.value })
    const second = createConnectionsRuntime({ definitions: { mail: mailConnection() }, store: test.store, fetch: test.provider.fetch, now: () => test.now.value })
    const replace = test.store.bridge.replace
    let arrived = 0
    let enter!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    let resume!: () => void
    const release = new Promise<void>(resolve => { resume = resolve })
    test.store.bridge.replace = async (...args) => {
      if (++arrived === 1) { enter(); await release }
      return await replace(...args)
    }
    const first = connect(test, { access_token: "access-one", refresh_token: "refresh-one", id_token: "account-one" })
    await entered
    const other = connect({ ...test, runtime: second }, { access_token: "access-two", refresh_token: "refresh-two", id_token: "account-one" })
    let blockedExchanges: number
    try {
      await new Promise(resolve => setTimeout(resolve, 50))
      blockedExchanges = test.provider.calls.filter(call => call.url === "https://auth.example.com/token").length
    }
    finally { resume() }
    const results = await Promise.allSettled([first, other])
    expect(blockedExchanges).toBe(1)
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"])
    expect(await test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).toMatchObject({ labels: [{ id: "INBOX" }] })
    expect(test.provider.calls.filter(call => call.url === "https://auth.example.com/revoke")).toEqual([])
    expect(await test.runtime.inspect("mail")).toMatchObject({ account: { id: "account-one" }, status: "connected" })
  })

  it("keeps one account per Connection", async () => {
    const test = createTestRuntime()
    await connect(test)
    const error = await rejection(connect(test, { access_token: "other-access", id_token: "account-2", refresh_token: "other-refresh" }))
    expect(error).toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls.filter(call => call.url === "https://auth.example.com/revoke")).toHaveLength(0)
    expect(await test.runtime.inspect("mail")).toMatchObject({ account: { id: "account-1" } })
  })

  it.each([false, true])("keeps token and account together during overlapping callbacks (revoked: %s)", async (revoked) => {
    const test = createTestRuntime()
    if (revoked) {
      await connect(test)
      await test.runtime.revoke({ name: "mail" })
    }
    const second = createConnectionsRuntime({ definitions: { mail: mailConnection() }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const release = new Promise<void>(resolve => { resume = resolve })
    const put = test.store.state.putForToken
    test.store.state.putForToken = async (state, revision) => {
      enter()
      await release
      return await put(state, revision)
    }
    const first = connect(test)
    await entered
    const other = connect({ ...test, runtime: second }, { access_token: "other-access", id_token: "account-2", refresh_token: "other-refresh" })
    resume()
    await first
    await expect(other).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls.filter(call => call.url === "https://auth.example.com/revoke")).toHaveLength(revoked ? 1 : 0)
    expect(await test.runtime.inspect("mail")).toMatchObject({ account: { id: "account-1" }, status: "reauth_required" })
    expect(JSON.parse((await test.store.secrets.read("connection/mail"))!.value)).toMatchObject({ accessToken: ACCESS_TOKEN, accountId: "account-1" })
    await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  })

  it("does not revoke through a bridge that omits the leased revision", async () => {
    const test = createTestRuntime()
    await connect(test)
    const use = test.store.bridge.use
    test.store.bridge.use = (context, key, operation, run) => use(context, key, operation, secret => run(secret))
    await expect(test.runtime.revoke({ name: "mail" })).rejects.toBeDefined()
    expect(test.provider.calls.filter(call => call.url === "https://auth.example.com/revoke")).toHaveLength(0)
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" })
  })

  it("revokes the revision leased after a concurrent token replacement", async () => {
    const test = createTestRuntime()
    await connect(test)
    const inspect = test.store.secrets.inspect
    let replaced = false
    test.store.secrets.inspect = async key => {
      const stored = await inspect(key)
      if (!replaced && stored) {
        replaced = true
        const current = await test.store.secrets.read(key)
        if (!current) throw new Error("Expected connected token")
        await test.store.secrets.replace({ expectedRevision: stored.revision, key, value: JSON.stringify({ ...JSON.parse(current.value), accessToken: "new-access", refreshToken: "new-refresh" }) })
      }
      return stored
    }
    expect(await test.runtime.revoke({ name: "mail" })).toMatchObject({ status: "revoked" })
    expect(test.provider.calls.at(-1)).toMatchObject({ body: "token=new-refresh", url: "https://auth.example.com/revoke" })
    await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect((await test.runtime.activity({ name: "mail" })).some(event => event.action === "use" && event.operation === "revoke" && event.outcome === "succeeded" && event.revision)).toBe(true)
  })

  it.each([429, 500])("retains the token and mutation fence when provider revocation returns %s", async (status) => {
    const test = createTestRuntime()
    await connect(test)
    const token = await test.store.secrets.read("connection/mail")
    if (!token?.revision) throw new Error("Expected a persisted token revision.")
    test.runtime = createConnectionsRuntime({
      definitions: { mail: mailConnection() },
      store: test.store,
      now: () => test.now.value,
      fetch: async (input, init) => String(input) === "https://auth.example.com/revoke"
        ? new Response(null, { status })
        : test.provider.fetch(input, init),
    })
    await expect(test.runtime.revoke({ name: "mail" })).rejects.toMatchObject({ code: "CONNECTION_PROVIDER", details: { status } })
    expect(await test.store.secrets.read("connection/mail")).toEqual(token)
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" })
    expect(await test.store.refreshLeases.claim({ name: "mail", owner: "another-runtime", revision: token.revision, now: test.now.value, expiresAt: test.now.value + 1000 })).toBe("busy")
  })

  it("revokes the grant and blocks later calls", async () => {
    const test = createTestRuntime()
    await connect(test)
    expect(await test.runtime.revoke({ name: "mail" })).toMatchObject({ status: "revoked" })
    expect(test.provider.calls.at(-1)).toMatchObject({ body: `token=${REFRESH_TOKEN}`, url: "https://auth.example.com/revoke" })
    const error = await rejection(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))
    expect(error).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
  })
})

describe("OAuth scope fallback", () => {
  it("uses requested scopes when authorization omits scope and retains them on refresh", async () => {
    const test = createTestRuntime()
    await connect(test, { scope: undefined, expires_in: 1 })
    expect(await test.runtime.inspect("mail")).toMatchObject({
      scopes: { granted: ["openid", "mail.modify"], missing: [] },
    })
    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, expires_in: 3600 } })
    await test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })
    expect(await test.runtime.inspect("mail")).toMatchObject({
      scopes: { granted: ["openid", "mail.modify"], missing: [] },
    })
  })

  it("uses newly requested scopes when reconnect omits scope", async () => {
    const test = createTestRuntime()
    await connect(test, { scope: "openid" })
    const definition = { ...mailConnection(), scopes: ["mail.modify", "mail.extra"] }
    const runtime = createConnectionsRuntime({ definitions: { mail: definition }, fetch: test.provider.fetch, now: () => test.now.value, store: test.store })
    await connect({ ...test, runtime }, { scope: undefined })
    expect(await runtime.inspect("mail")).toMatchObject({ scopes: { granted: ["openid", "mail.modify", "mail.extra"], missing: [] } })
  })

  it("preserves an explicit reduced grant", async () => {
    const test = createTestRuntime()
    await connect(test, { scope: "openid" })
    expect(await test.runtime.inspect("mail")).toMatchObject({
      scopes: { granted: ["openid"], missing: ["mail.modify"] },
    })
  })
})

describe("calls", () => {
  it("builds provider requests from the catalog", async () => {
    const test = createTestRuntime()
    await connect(test)
    const client = test.runtime.client("mail", {})
    expect(await client.call("mail.labels.list", { userId: "me" })).toEqual({ labels: [{ id: "INBOX" }] })
    expect(await client.call("mail.messages.modify", { id: "a/b", requestBody: { addLabelIds: ["L1"] }, userId: "me" })).toEqual({ id: "message-1" })
    const [list, modify] = test.provider.calls.slice(-2)
    expect(list).toMatchObject({ method: "GET", url: "https://mail.example.com/mail/v1/users/me/labels" })
    expect(list!.headers.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(modify).toMatchObject({ body: "{\"addLabelIds\":[\"L1\"]}", method: "POST", url: "https://mail.example.com/mail/v1/users/me/messages/a%2Fb/modify" })
  })

  it("prepares repeated query parameters without mutating method input", async () => {
    const test = createTestRuntime()
    await connect(test)
    const input = { userId: "a/b", label: ["INBOX", "a b"], ignored: null, requestBody: { ignored: true } }
    await test.runtime.client("mail", {}).call("mail.labels.list", input)
    expect(test.provider.calls.at(-1)).toMatchObject({
      method: "GET", url: "https://mail.example.com/mail/v1/users/a%2Fb/labels?label=INBOX&label=a+b",
    })
    expect(test.provider.calls.at(-1)?.body).toBeUndefined()
    expect(input).toEqual({ userId: "a/b", label: ["INBOX", "a b"], ignored: null, requestBody: { ignored: true } })
  })

  it("rejects unexposed methods and missing path parameters before provider dispatch", async () => {
    const test = createTestRuntime()
    await connect(test)
    const calls = test.provider.calls.length
    await expect(test.runtime.client("mail", {}).call("mail.unknown", {})).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    await expect(test.runtime.client("mail", {}).call("mail.labels.list", {})).rejects.toThrow('requires "userId"')
    expect(test.provider.calls).toHaveLength(calls)
  })

  it("refreshes an expiring token once for concurrent calls", async () => {
    const test = createTestRuntime()
    await connect(test)
    test.now.value += 3600_000
    test.provider.valid = new Set(["access-2"])
    test.provider.tokenResponses.push({ body: { access_token: "access-2", expires_in: 3600 } })
    const client = test.runtime.client("mail", {})
    await Promise.all([client.call("mail.labels.list", { userId: "me" }), client.call("mail.labels.list", { userId: "me" })])
    expect(test.provider.calls.filter(call => call.url === "https://auth.example.com/token")).toHaveLength(2) // connect + one refresh
    const refresh = new URLSearchParams(test.provider.calls.find(call => call.body?.includes("grant_type=refresh_token"))!.body)
    expect(refresh.get("refresh_token")).toBe(REFRESH_TOKEN)
    // The refresh keeps the refresh token when the provider does not rotate it.
    test.now.value += 3600_000
    test.provider.valid = new Set(["access-3"])
    test.provider.tokenResponses.push({ body: { access_token: "access-3", expires_in: 3600 } })
    await client.call("mail.labels.list", { userId: "me" })
    expect(new URLSearchParams(test.provider.calls.filter(call => call.url === "https://auth.example.com/token").at(-1)!.body).get("refresh_token")).toBe(REFRESH_TOKEN)
  })

  it("uses the stored token when another isolate wins the refresh", async () => {
    const store = createStore()
    const first = createTestRuntime(mailConnection(), store)
    await connect(first)
    const second = createConnectionsRuntime({ definitions: { mail: mailConnection() }, fetch: first.provider.fetch, now: () => first.now.value, store })
    first.now.value += 3600_000
    first.provider.valid = new Set(["access-a", "access-b"])
    first.provider.tokenResponses.push({ body: { access_token: "access-a", expires_in: 3600 } }, { body: { access_token: "access-b", expires_in: 3600 } })
    await Promise.all([
      first.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }),
      second.client("mail", {}).call("mail.labels.list", { userId: "me" }),
    ])
    const tokens = first.provider.calls.filter(call => call.url.startsWith("https://mail.example.com/")).map(call => call.headers.get("authorization"))
    // The losing isolate discards its token and uses the stored one.
    expect(new Set(tokens).size).toBe(1)
  })

  it.each([
    { error: "temporarily_unavailable", status: 400 },
    { error: "temporarily_unavailable", status: 429 },
    { error: "server_error", status: 500 },
  ])("keeps explicit transient refresh failures retryable ($status)", async ({ error, status }) => {
    const test = createTestRuntime()
    await connect(test, { expires_in: 1 })
    test.provider.tokenResponses.push({ body: { error }, status })
    const client = test.runtime.client("mail", {})
    expect(await rejection(client.call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_PROVIDER", status })
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" })
    test.provider.valid = new Set(["access-after-outage"])
    test.provider.tokenResponses.push({ body: { access_token: "access-after-outage", expires_in: 3600 } })
    await client.call("mail.labels.list", { userId: "me" })
    expect(test.provider.calls.at(-1)?.headers.get("authorization")).toBe("Bearer access-after-outage")
  })

  it.each(["state", "audit"])("quarantines a committed refresh after its %s persistence fails", async (failure) => {
    const test = createTestRuntime()
    await connect(test, { expires_in: 1 })
    const original = await test.store.secrets.read("connection/mail")
    test.provider.tokenResponses.push({ body: { access_token: "replacement-access", expires_in: 3600, refresh_token: "replacement-refresh" } })
    test.provider.valid.add("replacement-access")
    if (failure === "state") {
      const put = test.store.state.putForToken
      test.store.state.putForToken = async (state, revision) => {
        if (state.refreshedAt && state.status === "connected") throw new Error("State persistence unavailable")
        return await put(state, revision)
      }
    }
    else {
      const append = test.store.access.append
      test.store.access.append = async (event) => {
        if (event.action === "replace" && event.outcome === "succeeded") throw new Error("Audit persistence unavailable")
        await append(event)
      }
    }
    await expect(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).rejects.toThrow()
    const replacement = await test.store.secrets.read("connection/mail")
    expect(replacement?.revision).not.toBe(original?.revision)
    expect(JSON.parse(replacement!.value)).toMatchObject({ accessToken: "replacement-access", refreshToken: "replacement-refresh" })
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "reauth_required" })
    const calls = test.provider.calls.length
    expect(await rejection(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(test.provider.calls).toHaveLength(calls)
  })

  it("requires reauthorization when a refresh response does not confirm a token", async () => {
    const test = createTestRuntime()
    await connect(test, { expires_in: 1 })
    test.provider.tokenResponses.push({ body: {} })
    const client = test.runtime.client("mail", {})
    expect(await rejection(client.call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_PROVIDER" })
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "reauth_required" })
    const calls = test.provider.calls.length
    expect(await rejection(client.call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(test.provider.calls).toHaveLength(calls)
  })

  it.each(["tokenless", "malformed"] as const)("quarantines a rotating grant after a %s HTTP success", async responseKind => {
    const test = createTestRuntime()
    await connect(test, { expires_in: 1 })
    let rotations = 0
    const providerFetch: typeof fetch = async (input, init) => {
      if (String(input) === "https://auth.example.com/token") {
        rotations += 1
        test.provider.valid.clear()
        return responseKind === "tokenless" ? Response.json({ refresh_token: "unconfirmed-replacement" }) : new Response("truncated token response", { status: 200 })
      }
      return await test.provider.fetch(input, init)
    }
    const runtime = createConnectionsRuntime({ definitions: { mail: mailConnection() }, fetch: providerFetch, now: () => test.now.value, store: test.store })
    const client = runtime.client("mail", {})
    expect(await rejection(client.call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_PROVIDER" })
    expect(await runtime.inspect("mail")).toMatchObject({ status: "reauth_required" })
    const count = test.provider.calls.length
    expect(await rejection(client.call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(test.provider.calls).toHaveLength(count)
    expect(rotations).toBe(1)
  })

  it("maps malformed successful provider JSON to a Connection error", async () => {
    const test = createTestRuntime()
    await connect(test)
    const runtime = createConnectionsRuntime({
      definitions: { mail: mailConnection() },
      fetch: async (input, init) => String(input) === "https://mail.example.com/mail/v1/users/me/labels"
        ? new Response("truncated response", { status: 200 })
        : await test.provider.fetch(input, init),
      now: () => test.now.value,
      store: test.store,
    })
    await expect(runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))
      .rejects.toMatchObject({ code: "CONNECTION_PROVIDER", message: "Provider returned invalid JSON." })
  })

  it("marks the Connection for reauthorization after invalid_grant", async () => {
    const test = createTestRuntime()
    await connect(test)
    test.now.value += 3600_000
    test.provider.tokenResponses.push({ body: { error: "invalid_grant" }, status: 400 })
    const error = await rejection(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))
    expect(error).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "reauth_required" })
    const calls = test.provider.calls.length
    expect(await rejection(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(test.provider.calls).toHaveLength(calls)
  })

  it("refreshes and retries once after a 401", async () => {
    const test = createTestRuntime()
    await connect(test)
    test.provider.valid = new Set(["access-2"])
    test.provider.tokenResponses.push({ body: { access_token: "access-2", expires_in: 3600 } })
    expect(await test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).toEqual({ labels: [{ id: "INBOX" }] })
  })

  it.each(["agent:", "user:", "", "agent:bad\u0000id", "n".repeat(513)])("rejects malformed actors without corrupting denied activity (%s)", async (actor) => {
    const test = createTestRuntime(mailConnection({ server: { read: true } }))
    await connect(test)
    const before = await test.runtime.activity({ name: "mail" })
    const calls = test.provider.calls.length
    const client = test.runtime.client("mail", { actor })
    const error = await rejection(client.call("mail.labels.list", { userId: "me" }))
    expect(await test.runtime.activity({ name: "mail" })).toEqual(before)
    expect(error).toMatchObject({ code: "CONNECTION_INVALID" })
    expect(await rejection(client.fetch("https://mail.example.com/mail/v1/users/me/labels"))).toMatchObject({ code: "CONNECTION_INVALID" })
    expect((await test.runtime.approvals({})).approvals).toEqual([])
    expect(test.provider.calls).toHaveLength(calls)
    expect(await test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" })).toMatchObject({ labels: [{ id: "INBOX" }] })
  })

  it("keeps secrets out of errors and activity", async () => {
    const test = createTestRuntime()
    await connect(test)
    test.provider.valid = new Set()
    test.provider.tokenResponses.push({ body: { access_token: "access-2", expires_in: 3600 } })
    const error = await rejection(test.runtime.client("mail", {}).call("mail.labels.list", { userId: "me" }))
    expect(error).toMatchObject({ code: "CONNECTION_PROVIDER", status: 401 })
    const activity = await test.runtime.activity({ name: "mail" })
    const serialized = JSON.stringify({ activity, error, message: (error as Error).message, stack: (error as Error).stack })
    for (const secret of [ACCESS_TOKEN, "access-2", REFRESH_TOKEN, CLIENT_SECRET]) expect(serialized).not.toContain(secret)
    expect(activity.some(entry => entry.operation === "mail.labels.list" && entry.outcome === "failed")).toBe(true)
  })

  it.each([["patch", "patch"], ["Egg", "Egg"], ["gEt", "GET"]])("uses Fetch method normalization for %s", async (method, expected) => {
    const test = createTestRuntime(mailConnection({ server: { read: true, write: ["fetch"] } }))
    await connect(test)
    await test.runtime.client("mail", {}).fetch("https://mail.example.com/mail/v1/users/me/labels", { method })
    expect(test.provider.calls.at(-1)?.method).toBe(expected)
  })

  it.each(["gEt", "hEaD"])("executes normalized %s reads with read-only access in dry run", async method => {
    const test = createTestRuntime(mailConnection({ server: { read: true } }))
    await connect(test)
    const response = await test.runtime.client("mail", { dryRun: true }).fetch("https://mail.example.com/mail/v1/users/me/labels", { method })
    expect(response.status).toBe(200)
    expect(test.provider.calls.at(-1)?.method).toBe(method.toUpperCase())
  })

  it.each(["HEAD", "OPTIONS"])("executes catalog %s reads in dry run", async method => {
    const definition = mailConnection({ server: { read: true, write: ["mail.messages.modify"] } })
    const provider = testProvider()
    const test = createTestRuntime(async () => ({ default: {
      ...definition,
      provider: { ...provider, apis: { mail: { ...provider.apis.mail, methods: { ...provider.apis.mail.methods, "messages.modify": [method, "mail/v1/users/{userId}/messages/{id}", false] } } } },
    } }))
    await connect(test)
    const result = await test.runtime.client("mail", { dryRun: true }).call("mail.messages.modify", { id: "m1", userId: "me" })
    expect(result).toEqual({ id: "message-1" })
    expect(test.provider.calls.at(-1)?.method).toBe(method)
  })

  it("sends fetch only to catalog origins", async () => {
    const test = createTestRuntime()
    await connect(test)
    const client = test.runtime.client("mail", {})
    expect((await client.fetch("https://mail.example.com/mail/v1/users/me/labels")).status).toBe(200)
    expect(await rejection(client.fetch("https://attacker.example.com/"))).toMatchObject({ code: "CONNECTION_INVALID" })
    expect(await rejection(client.fetch("https://mail.example.com/mail/v1/x", { body: "{}", method: "POST" }))).toMatchObject({ code: "CONNECTION_DENIED" })
  })

  it.each([new URLSearchParams("label=INBOX"), new FormData()])("rejects unsupported bodies from untyped callers before dispatch (%s)", async (body) => {
    const test = createTestRuntime(mailConnection({ server: { read: true, write: ["fetch"] } }))
    await connect(test)
    const calls = test.provider.calls.length
    const client = test.runtime.client("mail", {})
    const result = Reflect.apply(client.fetch, client, ["https://mail.example.com/mail/v1/users/me/messages/m1/modify", { body, method: "POST" }])
    expect(await rejection(result)).toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.provider.calls).toHaveLength(calls)
  })

  it("applies the JSON content type only to typed method bodies", async () => {
    const test = createTestRuntime(mailConnection({ server: { read: true, write: ["fetch", "mail.messages.modify"] } }))
    await connect(test)
    const client = test.runtime.client("mail", {})
    await client.fetch("https://mail.example.com/mail/v1/users/me/messages/m1/modify", { body: "label=INBOX", method: "POST" })
    const raw = test.provider.calls.at(-1)!
    expect(raw.headers.has("content-type")).toBe(false)
    expect(new Request(raw.url, { body: raw.body, headers: raw.headers, method: raw.method }).headers.get("content-type"))
      .toBe("text/plain;charset=UTF-8")
    await client.fetch("https://mail.example.com/mail/v1/users/me/messages/m1/modify", { body: "label=INBOX", headers: { "Content-Type": "application/x-www-form-urlencoded" }, method: "POST" })
    expect(test.provider.calls.at(-1)!.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
    await client.call("mail.messages.modify", { id: "m1", requestBody: { addLabelIds: ["INBOX"] }, userId: "me" })
    expect(test.provider.calls.at(-1)!.headers.get("content-type")).toBe("application/json")
  })

  it("preserves caller Accept headers and defaults absent values", async () => {
    const test = createTestRuntime()
    await connect(test)
    const client = test.runtime.client("mail", {})
    await client.fetch("https://mail.example.com/mail/v1/users/me/labels", { headers: { Accept: "application/vnd.example+json" } })
    expect(test.provider.calls.at(-1)!.headers.get("accept")).toBe("application/vnd.example+json")
    await client.fetch("https://mail.example.com/mail/v1/users/me/labels")
    expect(test.provider.calls.at(-1)!.headers.get("accept")).toBe("application/json")
  })

  it("sanitizes caller set-cookie headers for OAuth requests", async () => {
    const test = createTestRuntime()
    await connect(test)
    await test.runtime.client("mail", {}).fetch("https://mail.example.com/mail/v1/users/me/labels", {
      headers: { "set-cookie": "session=secret" },
    })
    expect(test.provider.calls.at(-1)!.headers.has("set-cookie")).toBe(false)
  })
})

describe("policy", () => {
  it("allows declared writes for server code and asks approval for Agents by default", async () => {
    const test = createTestRuntime()
    await connect(test)
    await expect(test.runtime.client("mail", {}).call("mail.messages.modify", { id: "m1", userId: "me" })).resolves.toEqual({ id: "message-1" })
    expect(await rejection(test.runtime.client("mail", {}).call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    await expect(test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }) }).call("mail.labels.list", { userId: "me" })).resolves.toBeDefined()
    const error = await rejection(test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }) }).call("mail.messages.modify", { id: "m1", userId: "me" }))
    expect(isConnectionError(error) && error.reason).toBe("approval_required")
  })

  it("takes an Agent actor only from an Env context that the Agent runtime created", async () => {
    const test = createTestRuntime(mailConnection({ "agent:labeller": { read: true } }))
    await connect(test)
    const calls = test.provider.calls.length
    const before = await test.runtime.activity({ name: "mail" })
    const forged = [
      { access: { actor: { id: "labeller", kind: "agent" } } },
      { access: { ...agentEnvAccess({ name: "labeller" }) } },
    ] as unknown as UseConnectionOptions[]
    for (const options of forged) {
      expect(await rejection(test.runtime.client("mail", options).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "ENV_BRIDGE_UNTRUSTED" })
    }
    for (const options of [{ actor: "agent:labeller" }, { access: agentEnvAccess({ name: "labeller" }), actor: "server" }]) {
      expect(await rejection(test.runtime.client("mail", options).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_INVALID" })
    }
    expect(test.provider.calls).toHaveLength(calls)
    expect(await test.runtime.activity({ name: "mail" })).toEqual(before)
    expect(await rejection(test.runtime.client("mail", { access: agentEnvAccess({ name: "other" }) }).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    await expect(test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }) }).call("mail.labels.list", { userId: "me" })).resolves.toBeDefined()
  })

  it("denies actors that the access map does not list and records the denial", async () => {
    const test = createTestRuntime(mailConnection({
      "schedule:gmail": { read: true, write: ["mail.messages.modify"] },
    }))
    await connect(test)
    const scheduled = test.runtime.client("mail", { actor: "schedule:gmail", traceId: "trace-1" })
    await expect(scheduled.call("mail.messages.modify", { id: "m1", userId: "me" })).resolves.toEqual({ id: "message-1" })
    expect(await rejection(scheduled.call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    const calls = test.provider.calls.length
    expect(await rejection(test.runtime.client("mail", { actor: "server" }).call("mail.labels.list", { userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    expect(test.provider.calls).toHaveLength(calls)
    const activity = await test.runtime.activity({ name: "mail" })
    expect(activity.filter(entry => entry.outcome === "denied").map(entry => ({ actor: entry.actor, operation: entry.operation }))).toEqual(expect.arrayContaining([
      { actor: { id: "server", kind: "service" }, operation: "mail.labels.list" },
      { actor: { id: "schedule:gmail", kind: "service" }, operation: "mail.messages.send" },
    ]))
    expect(activity.find(entry => entry.operation === "mail.messages.modify" && entry.outcome === "succeeded")).toMatchObject({ traceId: "trace-1" })
  })

  it("requires exact names for high-risk writes", async () => {
    const test = createTestRuntime(mailConnection({
      "server": { read: true, write: ["mail.messages.*"] },
      "schedule:send": { write: ["mail.messages.send"] },
    }))
    await connect(test)
    expect(await rejection(test.runtime.client("mail", {}).call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
    await expect(test.runtime.client("mail", { actor: "schedule:send" }).call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" })).resolves.toEqual({ id: "message-1" })
  })
})

describe("dry run", () => {
  it("reports writes without calling the provider", async () => {
    const test = createTestRuntime()
    await connect(test)
    const effects: ConnectionEffect[] = []
    const client = test.runtime.client("mail", { dryRun: true, onEffect: effect => effects.push(effect) })
    await expect(client.call("mail.labels.list", { userId: "me" })).resolves.toEqual({ labels: [{ id: "INBOX" }] })
    const calls = test.provider.calls.length
    await expect(client.call("mail.messages.modify", { id: "m1", requestBody: { addLabelIds: ["L1"] }, userId: "me" })).resolves.toBeUndefined()
    expect((await client.fetch("https://mail.example.com/x", { body: "{}", method: "POST" }).catch(error => error)).code).toBe("CONNECTION_DENIED")
    expect(test.provider.calls).toHaveLength(calls)
    expect(effects).toEqual([{
      kind: "mail.messages.modify",
      payload: { connection: "mail", input: { id: "m1", requestBody: { addLabelIds: ["L1"] }, userId: "me" }, method: "POST", url: "https://mail.example.com/mail/v1/users/me/messages/m1/modify" },
      read: false,
      skipped: "dry-run",
    }])
  })

  it("still denies writes that the policy denies", async () => {
    const test = createTestRuntime()
    await connect(test)
    const client = test.runtime.client("mail", { dryRun: true })
    expect(await rejection(client.call("mail.messages.send", { requestBody: { raw: "x" }, userId: "me" }))).toMatchObject({ code: "CONNECTION_DENIED" })
  })
})

describe("approvals", () => {
  it.each(["disconnected", "grantless", "reauth_required", "revoked"])("requires a connected grant before approval creation (%s)", async (status) => {
    const test = createTestRuntime(mailConnection({ "agent:labeller": { write: ["mail.messages.modify", "fetch"] } }))
    if (status !== "disconnected") {
      await connect(test)
      if (status === "grantless") {
        const current = await test.store.secrets.read("connection/mail")
        const token = JSON.parse(current!.value)
        delete token.grantId
        await test.store.secrets.replace({ expectedRevision: current!.revision!, key: "connection/mail", value: JSON.stringify(token) })
      }
      else {
        const state = await test.store.state.get("mail")
        await test.store.state.put({ ...state!, status: status === "revoked" ? "revoked" : "reauth_required" })
      }
    }
    const calls = test.provider.calls.length
    const client = test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }) })
    expect(await rejection(client.call("mail.messages.modify", { id: "m1", userId: "me" }))).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(await rejection(client.fetch("https://mail.example.com/mail/v1/users/me/messages/m1/modify", { method: "POST" }))).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect((await test.runtime.approvals({ status: "pending" })).approvals).toEqual([])
    expect(test.provider.calls).toHaveLength(calls)
    await connect(test)
    expect(await rejection(client.call("mail.messages.modify", { id: "m1", userId: "me" }))).toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
    const [approval] = (await test.runtime.approvals({ status: "pending" })).approvals
    expect(await test.runtime.approve({ id: approval!.id })).toMatchObject({ approval: { status: "executed" } })
  })

  it("preserves extension method casing in approval replay", async () => {
    const test = createTestRuntime(mailConnection({ "agent:labeller": { write: ["fetch"] } }))
    await connect(test)
    const error = await rejection(test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }) }).fetch("https://mail.example.com/mail/v1/users/me/messages/m1/modify", { method: "Egg" }))
    expect(error).toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
    const id = isConnectionError(error) ? error.requestId! : ""
    expect((await test.runtime.approvals({ status: "pending" })).approvals).toEqual([expect.objectContaining({ input: expect.objectContaining({ method: "Egg" }) })])
    await test.runtime.approve({ id })
    expect(test.provider.calls.at(-1)?.method).toBe("Egg")
  })

  it("preserves Accept when replaying an approved fetch", async () => {
    const test = createTestRuntime(mailConnection({ "agent:labeller": { write: ["fetch"] } }))
    await connect(test)
    const error = await rejection(test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }) }).fetch("https://mail.example.com/mail/v1/users/me/messages/m1/modify", { method: "POST", body: "{}", headers: { Accept: "application/vnd.example+json" } }))
    expect(error).toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
    const id = isConnectionError(error) ? error.requestId! : ""
    await test.runtime.approve({ id })
    expect(test.provider.calls.at(-1)!.headers.get("accept")).toBe("application/vnd.example+json")
  })

  it("replays an approved write once under the requesting actor", async () => {
    const test = createTestRuntime()
    await connect(test)
    const error = await rejection(test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }), invocationId: "inv-1" }).call("mail.messages.modify", { id: "m1", requestBody: { addLabelIds: ["L1"] }, userId: "me" }))
    const id = isConnectionError(error) ? error.requestId! : ""
    expect((await test.runtime.approvals({ status: "pending" })).approvals).toEqual([expect.objectContaining({ action: "mail.messages.modify", actor: "agent:labeller", id, invocationId: "inv-1", name: "mail", status: "pending" })])
    const calls = test.provider.calls.length
    const approved = await test.runtime.approve({ actor: "user:owner", id })
    expect(approved).toMatchObject({ approval: { decidedBy: "user:owner", status: "executed" }, result: { id: "message-1" } })
    expect(test.provider.calls.slice(calls)).toEqual([expect.objectContaining({ body: "{\"addLabelIds\":[\"L1\"]}", method: "POST" })])
    expect(await rejection(test.runtime.approve({ id }))).toMatchObject({ code: "CONNECTION_INVALID" })
    const activity = await test.runtime.activity({ name: "mail" })
    expect(activity.find(entry => entry.operation === "mail.messages.modify" && entry.outcome === "succeeded")).toMatchObject({ actor: { id: "labeller", kind: "agent" }, invocationId: "inv-1" })
  })

  it("keeps a slow provider write active across concurrent runtime inspection", async () => {
    const test = createTestRuntime()
    await connect(test)
    const error = await rejection(
      test.runtime
        .client("mail", { access: agentEnvAccess({ name: "labeller" }) })
        .call("mail.messages.modify", { id: "m1", userId: "me" }),
    )
    const id = isConnectionError(error) ? error.requestId! : ""
    let finish!: (response: Response) => void
    let started!: () => void
    const dispatched = new Promise<void>((resolve) => {
      started = resolve
    })
    const slowFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (!url.includes("/modify")) return await test.provider.fetch(input, init)
      started()
      return await new Promise<Response>((resolve) => {
        finish = resolve
      })
    }
    const executing = createConnectionsRuntime({
      definitions: { mail: mailConnection() },
      fetch: slowFetch,
      now: () => test.now.value,
      store: test.store,
    })
    const inspecting = createConnectionsRuntime({
      definitions: { mail: mailConnection() },
      now: () => test.now.value,
      store: test.store,
    })
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
    const replay = executing.approve({ id })
    try {
      await dispatched
      for (let minute = 0; minute < 6; minute++) {
        test.now.value += 60_000
        await vi.advanceTimersByTimeAsync(60_000)
        expect((await inspecting.approvals({ status: "approved" })).approvals).toEqual([
          expect.objectContaining({ id, status: "approved" }),
        ])
      }
      expect(await rejection(inspecting.approve({ id }))).toMatchObject({
        code: "CONNECTION_INVALID",
      })
      finish(Response.json({ id: "message-1" }))
      expect(await replay).toMatchObject({
        approval: { status: "executed" },
        result: { id: "message-1" },
      })
      test.now.value += 5 * 60_000
      expect((await inspecting.approvals({ status: "failed" })).approvals).toEqual([])
    } finally {
      finish(Response.json({ id: "message-1" }))
      await replay
      vi.useRealTimers()
    }
  })

  it.each([
    { dispatched: false, leased: false },
    { dispatched: true, leased: false },
    { dispatched: false, leased: true },
    { dispatched: true, leased: true },
  ])(
    "recovers an interrupted replay without repeating a provider write, %j",
    async ({ dispatched, leased }) => {
      const test = createTestRuntime()
      await connect(test)
      const error = await rejection(
        test.runtime
          .client("mail", { access: agentEnvAccess({ name: "labeller" }) })
          .call("mail.messages.modify", { id: "m1", userId: "me" }),
      )
      const id = isConnectionError(error) ? error.requestId! : ""
      await test.store.approvals.transition(id, "pending", "approved", {
        decidedAt: new Date(test.now.value).toISOString(),
        decidedBy: "user:owner",
        ...(leased
          ? { executionExpiresAt: new Date(test.now.value + 5 * 60_000).toISOString() }
          : {}),
      })
      // Model interruption either before dispatch or after the provider commits the write.
      if (dispatched)
        await test.runtime
          .client("mail", {})
          .call("mail.messages.modify", { id: "m1", userId: "me" })
      const calls = test.provider.calls.length
      const restarted = createConnectionsRuntime({
        definitions: { mail: mailConnection() },
        fetch: test.provider.fetch,
        now: () => test.now.value,
        store: test.store,
      })
      expect((await restarted.approvals({ status: "approved" })).approvals).toEqual([
        expect.objectContaining({ id, status: "approved" }),
      ])
      test.now.value += 5 * 60_000
      expect((await restarted.approvals({ status: "failed" })).approvals).toEqual([
        expect.objectContaining({ error: "CONNECTION_EXECUTION_UNKNOWN", id, status: "failed" }),
      ])
      expect(await rejection(restarted.approve({ id }))).toMatchObject({
        code: "CONNECTION_INVALID",
      })
      expect(test.provider.calls).toHaveLength(calls)
    },
  )

  it("recovers interrupted approvals beyond the inspection page", async () => {
    const test = createTestRuntime()
    for (let index = 0; index < 101; index++) {
      const id = `interrupted-${index}`
      await test.store.approvals.create({ action: "mail.messages.modify", actor: "agent:labeller", createdAt: new Date(test.now.value).toISOString(), id, input: { input: { id: "m1", userId: "me" }, kind: "method" }, name: "mail", status: "pending" })
      await test.store.approvals.transition(id, "pending", "approved", { decidedAt: new Date(test.now.value).toISOString() })
    }
    test.now.value += 5 * 60_000
    expect((await test.runtime.approvals({ status: "approved" })).approvals).toEqual([])
    expect(await test.store.approvals.get("interrupted-0")).toMatchObject({ error: "CONNECTION_EXECUTION_UNKNOWN", status: "failed" })
    expect(test.provider.calls).toEqual([])
  })

  it("denies a pending write without calling the provider", async () => {
    const test = createTestRuntime()
    await connect(test)
    const error = await rejection(test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }) }).call("mail.messages.modify", { id: "m1", userId: "me" }))
    const id = isConnectionError(error) ? error.requestId! : ""
    const calls = test.provider.calls.length
    expect(await test.runtime.deny({ actor: "user:owner", id })).toMatchObject({ decidedBy: "user:owner", status: "denied" })
    expect(test.provider.calls).toHaveLength(calls)
    expect(await rejection(test.runtime.approve({ id }))).toMatchObject({ code: "CONNECTION_INVALID" })
  })

  it("marks a failed replay", async () => {
    const test = createTestRuntime()
    await connect(test)
    const error = await rejection(test.runtime.client("mail", { access: agentEnvAccess({ name: "labeller" }) }).call("mail.messages.modify", { id: "m1", userId: "me" }))
    const id = isConnectionError(error) ? error.requestId! : ""
    await test.runtime.revoke({ name: "mail" })
    expect(await rejection(test.runtime.approve({ id }))).toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect((await test.runtime.approvals({})).approvals).toEqual([expect.objectContaining({ error: "CONNECTION_REAUTH_REQUIRED", id, status: "failed" })])
  })
})
