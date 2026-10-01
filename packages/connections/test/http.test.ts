import { createHash } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import { createConnectionsHandler } from "../src/http.ts"
import { oauth2 } from "../src/providers/oauth2.ts"
import { accessToken, mockFetch, refreshToken, setupRuntime, tokenSet } from "./helpers.ts"

import type { ConnectionsAccess } from "../src/http.ts"
import type { ConnectionDefinition } from "../src/types.ts"

const origin = "https://app.example"
const base = `${origin}/_vitehub/connections`
const admin: ConnectionsAccess = { actor: { id: "owner", kind: "user" }, admin: true }
const viewer: ConnectionsAccess = { actor: { id: "viewer", kind: "user" }, admin: false }
const clientSecret = "client-secret-value"

function providerFetch() {
  return mockFetch((url) => {
    if (url.pathname === "/token") {
      return Response.json({ access_token: accessToken, expires_in: 3600, refresh_token: refreshToken, scope: "openid email test.read", token_type: "Bearer" })
    }
    if (url.pathname === "/userinfo") return Response.json({ email: "owner@example.com", sub: "123" })
    if (url.pathname === "/revoke") return new Response(null, { status: 200 })
    return Response.json({ ok: true })
  })
}

function setup(access: ConnectionsAccess | null = admin) {
  const upstream = providerFetch()
  const definition: ConnectionDefinition = {
    provider: oauth2({
      authorizationUrl: "https://auth.example/authorize",
      client: () => ({ clientId: "client-id", clientSecret }),
      id: "example",
      origins: ["https://api.example", "https://auth.example"],
      revokeUrl: "https://auth.example/revoke",
      scopes: ["openid", "email", "test.read"],
      tokenUrl: "https://auth.example/token",
      userInfoUrl: "https://auth.example/userinfo",
    }),
  }
  const context = setupRuntime({ definition, fetch: upstream.fetch, name: "gmail" })
  const authenticate = vi.fn(async (_request: Request, _event: unknown) => access)
  const returnTo = vi.fn((name: string, outcome: "connected" | "failed") => `/settings?connection=${name}&outcome=${outcome}`)
  const handler = createConnectionsHandler({ authenticate, returnTo, runtime: context.runtime })
  return { ...context, authenticate, handler, returnTo, upstream }
}

function manage(input: unknown, headers: Record<string, string> = { origin }): Request {
  return new Request(`${base}/manage`, { body: typeof input === "string" ? input : JSON.stringify(input), headers, method: "POST" })
}

function stateCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? ""
  const match = /vitehub_connection_state=([^;]*)/.exec(header)
  if (!match) throw new Error("Missing state cookie.")
  return decodeURIComponent(match[1]!)
}

async function startConnect(handler: ReturnType<typeof setup>["handler"]): Promise<{ state: string, ticketUrl: string, authorizationUrl: URL, response: Response }> {
  const started = await handler(manage({ action: "start", name: "gmail" }))
  expect(started.status).toBe(200)
  const { url: ticketUrl } = await started.json() as { url: string }
  const response = await handler(new Request(ticketUrl))
  expect(response.status).toBe(302)
  return { authorizationUrl: new URL(response.headers.get("location")!), response, state: stateCookie(response), ticketUrl }
}

function callback(query: Record<string, string>, cookie?: string): Request {
  return new Request(`${base}/gmail/callback?${new URLSearchParams(query)}`, cookie ? { headers: { cookie } } : undefined)
}

describe("Connections management route", () => {
  it("rejects cross-origin and unproven requests before authentication", async () => {
    const { authenticate, handler } = setup()
    const rejected: Array<Record<string, string>> = [{ origin: "https://attacker.example" }, {}, { authorization: "Basic abc" }, { origin: "null" }, { authorization: "Bearer token", origin: "https://attacker.example" }]
    for (const headers of rejected) {
      const response = await handler(manage({ action: "list" }, headers))
      expect(response.status).toBe(403)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
    expect(authenticate).not.toHaveBeenCalled()
  })

  it("accepts a bearer request without an origin and passes it to authentication", async () => {
    const { authenticate, handler } = setup()
    const request = manage({ action: "list" }, { authorization: "Bearer token" })
    const event = { id: "event" }
    expect((await handler(request, event)).status).toBe(200)
    expect(authenticate).toHaveBeenCalledWith(request, event)
  })

  it("requires authentication", async () => {
    const { handler } = setup(null)
    const response = await handler(manage({ action: "list" }))
    expect(response.status).toBe(401)
  })

  it("only accepts POST", async () => {
    const { handler } = setup()
    expect((await handler(new Request(`${base}/manage`, { headers: { origin } }))).status).toBe(405)
  })

  it("rejects invalid and oversized bodies", async () => {
    const { handler } = setup()
    expect((await handler(manage("{not json"))).status).toBe(400)
    expect((await handler(manage({ action: "unknown" }))).status).toBe(400)
    expect((await handler(manage({ action: "inspect" }))).status).toBe(400)
    expect((await handler(manage({ action: "list", padding: "x".repeat(60_000) }))).status).toBe(200)
    const oversized = await handler(manage({ action: "list", padding: "x".repeat(70_000) }))
    expect(oversized.status).toBe(400)
    expect(await oversized.json()).toMatchObject({ code: "CONNECTIONS_INVALID" })
  })

  it("lets non-admins read but not change Connections", async () => {
    const { handler, store } = setup(viewer)
    await store.write({ name: "gmail", provider: "example", tokens: tokenSet() })

    const list = await handler(manage({ action: "list" }))
    expect(list.status).toBe(200)
    const body = await list.text()
    expect(JSON.parse(body)).toMatchObject({ admin: false, connections: [{ name: "gmail", status: "active" }] })
    expect(body).not.toContain(accessToken)
    expect(body).not.toContain(refreshToken)
    expect((await handler(manage({ action: "inspect", name: "gmail" }))).status).toBe(200)
    expect((await handler(manage({ action: "activity" }))).status).toBe(200)
    for (const action of ["start", "refresh", "disconnect"]) {
      const response = await handler(manage({ action, name: "gmail" }))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: "CONNECTIONS_DENIED" })
    }
    expect(await store.grant("gmail")).toBeDefined()
  })

  it("maps runtime errors to status codes", async () => {
    const { handler } = setup()
    const missing = await handler(manage({ action: "inspect", name: "unknown" }))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ code: "CONNECTIONS_NOT_FOUND", message: expect.any(String) })
    expect((await handler(manage({ action: "refresh", name: "gmail" }))).status).toBe(409)
  })

  it("refreshes and disconnects for admins", async () => {
    const { handler, store, upstream } = setup()
    await store.write({ name: "gmail", provider: "example", tokens: tokenSet() })

    const refreshed = await handler(manage({ action: "refresh", name: "gmail" }))
    expect(refreshed.status).toBe(200)
    expect(await refreshed.json()).toMatchObject({ connection: { name: "gmail", status: "active" } })
    const disconnected = await handler(manage({ action: "disconnect", name: "gmail" }))
    expect(await disconnected.json()).toMatchObject({ connection: { status: "disconnected" } })
    expect(upstream.calls.map(call => call.url)).toEqual(["https://auth.example/token", "https://auth.example/revoke"])
    const activity = await handler(manage({ action: "activity", name: "gmail", limit: 10 }))
    const { events } = await activity.json() as { events: Array<{ action: string, actor: unknown }> }
    expect(events.map(event => event.action)).toEqual(["disconnect", "refresh"])
    expect(events[0]!.actor).toEqual(admin.actor)
  })
})

describe("Connections connect routes", () => {
  it("keeps connect and callback closed for callers without admin access", async () => {
    const { handler, runtime, store } = setup()
    const { state } = await startConnect(handler)
    const viewerHandler = createConnectionsHandler({ authenticate: async () => viewer, runtime })
    const denied = await viewerHandler(callback({ code: "code", state }, `vitehub_connection_state=${state}`))
    expect(denied.status).toBe(403)
    expect((await viewerHandler(new Request(`${base}/gmail/connect?ticket=x`))).status).toBe(403)
    const anonymous = createConnectionsHandler({ authenticate: async () => null, runtime: setup().runtime })
    expect((await anonymous(new Request(`${base}/gmail/connect?ticket=x`))).status).toBe(401)
    expect(await store.grant("gmail")).toBeUndefined()
  })

  it("reports a completed connect as connected when the activity insert fails", async () => {
    const context = setup()
    const failing = createConnectionsHandler({
      authenticate: async () => admin,
      returnTo: context.returnTo,
      runtime: { ...context.runtime, record: async () => { throw new Error("activity store down") } },
    })
    const { state } = await startConnect(failing)
    const originalRun = context.db.run.bind(context.db)
    // SAFETY: The spy keeps the database contract and only fails activity inserts.
    vi.spyOn(context.db, "run").mockImplementation(((query: Parameters<typeof context.db.run>[0]) =>
      JSON.stringify(query).includes("INSERT INTO vitehub_connection_activity") ? Promise.reject(new Error("activity store down")) : originalRun(query)) as typeof context.db.run)

    const response = await failing(callback({ code: "code", state }, `vitehub_connection_state=${state}`))
    expect(response.headers.get("location")).toBe("/settings?connection=gmail&outcome=connected")
    expect(await context.store.grant("gmail")).toMatchObject({ status: "active" })
    // The insert really failed: no connect activity exists.
    expect(await context.runtime.activity({ connection: "gmail" })).toEqual([])
  })

  it("completes the connect and callback flow", async () => {
    const { handler, returnTo, runtime, upstream } = setup()
    const { authorizationUrl, response, state } = await startConnect(handler)

    const cookie = response.headers.get("set-cookie")!
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("Path=/_vitehub/connections/gmail")
    expect(cookie).toContain("Max-Age=600")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe("https://auth.example/authorize")
    expect(Object.fromEntries(authorizationUrl.searchParams)).toMatchObject({
      client_id: "client-id",
      code_challenge_method: "S256",
      redirect_uri: `${base}/gmail/callback`,
      response_type: "code",
      scope: "openid email test.read",
      state,
    })
    expect(authorizationUrl.searchParams.has("client_secret")).toBe(false)

    const done = await handler(callback({ code: "auth-code", state }, `other=1; vitehub_connection_state=${encodeURIComponent(state)}`))
    expect(done.status).toBe(302)
    expect(done.headers.get("location")).toBe("/settings?connection=gmail&outcome=connected")
    expect(done.headers.get("set-cookie")).toContain("Max-Age=0")
    expect(returnTo).toHaveBeenCalledWith("gmail", "connected")

    const [tokenCall, userInfoCall] = upstream.calls
    const tokenBody = new URLSearchParams(tokenCall!.body)
    expect(tokenCall!.url).toBe("https://auth.example/token")
    expect(tokenBody.get("grant_type")).toBe("authorization_code")
    expect(tokenBody.get("code")).toBe("auth-code")
    expect(tokenBody.get("redirect_uri")).toBe(`${base}/gmail/callback`)
    expect(tokenBody.get("client_secret")).toBe(clientSecret)
    const verifier = tokenBody.get("code_verifier")!
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(authorizationUrl.searchParams.get("code_challenge"))
    expect(userInfoCall).toMatchObject({ authorization: `Bearer ${accessToken}`, url: "https://auth.example/userinfo" })

    expect(await runtime.inspect("gmail")).toMatchObject({ account: "owner@example.com", scopes: ["openid", "email", "test.read"], status: "active" })
    expect(await runtime.activity({})).toEqual([expect.objectContaining({ action: "connect", actor: admin.actor, outcome: "succeeded" })])
  })

  it("does not mark the cookie Secure on http origins", async () => {
    const { handler, runtime } = setup()
    const { url } = await runtime.start("gmail", { actor: admin.actor, origin: "http://localhost:5173" })
    const response = await handler(new Request(url))
    expect(response.status).toBe(302)
    expect(response.headers.get("set-cookie")).not.toContain("Secure")
  })

  it("opens a ticket only once", async () => {
    const { handler } = setup()
    const { ticketUrl } = await startConnect(handler)

    const reused = await handler(new Request(ticketUrl))
    expect(reused.status).toBe(400)
    expect(await reused.json()).toMatchObject({ code: "CONNECTIONS_INVALID" })
    expect((await handler(new Request(`${base}/gmail/connect?ticket=unknown`))).status).toBe(400)
    expect((await handler(new Request(`${base}/gmail/connect`))).status).toBe(400)
    expect((await handler(new Request(`${base}/gmail/connect?ticket=${"x".repeat(129)}`))).status).toBe(400)
  })

  it("rejects a ticket for another Connection", async () => {
    const { handler } = setup()
    const started = await handler(manage({ action: "start", name: "gmail" }))
    const { url } = await started.json() as { url: string }
    const ticket = new URL(url).searchParams.get("ticket")!

    expect((await handler(new Request(`${base}/drive/connect?ticket=${ticket}`))).status).toBe(404)
  })

  it("rejects a callback whose state does not match the cookie", async () => {
    const { handler, runtime, upstream } = setup()
    const { state } = await startConnect(handler)

    const wrong = await handler(callback({ code: "auth-code", state: "attacker-state" }, `vitehub_connection_state=${encodeURIComponent(state)}`))
    expect(wrong.status).toBe(400)
    expect(wrong.headers.get("set-cookie")).toMatch(/^vitehub_connection_state=; Path=\/_vitehub\/connections\/gmail; Max-Age=0; HttpOnly/)
    expect(await wrong.json()).toMatchObject({ code: "CONNECTIONS_INVALID" })
    expect((await handler(callback({ code: "auth-code", state }))).status).toBe(400)
    expect((await handler(callback({ code: "auth-code", state }, "vitehub_connection_state=other"))).status).toBe(400)
    expect(upstream.calls).toEqual([])
    expect((await runtime.inspect("gmail")).status).toBe("disconnected")

    const ok = await handler(callback({ code: "auth-code", state }, `vitehub_connection_state=${encodeURIComponent(state)}`))
    expect(ok.headers.get("location")).toBe("/settings?connection=gmail&outcome=connected")
    const replay = await handler(callback({ code: "auth-code", state }, `vitehub_connection_state=${encodeURIComponent(state)}`))
    expect(replay.status).toBe(400)
  })

  it("rejects a callback before the ticket was opened", async () => {
    const { handler } = setup()
    await handler(manage({ action: "start", name: "gmail" }))
    expect((await handler(callback({ code: "auth-code", state: "s" }, "vitehub_connection_state=s"))).status).toBe(400)
  })

  it("redirects to the failed page when the provider returns an error", async () => {
    const { handler, returnTo, runtime, upstream } = setup()
    const { state } = await startConnect(handler)

    const failed = await handler(callback({ error: "access_denied", state }, `vitehub_connection_state=${encodeURIComponent(state)}`))
    expect(failed.status).toBe(302)
    expect(failed.headers.get("location")).toBe("/settings?connection=gmail&outcome=failed")
    expect(failed.headers.get("set-cookie")).toContain("Max-Age=0")
    expect(returnTo).toHaveBeenCalledWith("gmail", "failed")
    expect(upstream.calls).toEqual([])
    expect(await runtime.activity({})).toEqual([expect.objectContaining({ action: "connect", error: "CONNECTIONS_PROVIDER_FAILED", outcome: "failed" })])
  })

  it("redirects to the failed page when the token exchange fails", async () => {
    const { handler, runtime, upstream } = setup()
    upstream.mock.mockImplementation(async () => Response.json({ error: "invalid_request" }, { status: 400 }))
    const { state } = await startConnect(handler)

    const failed = await handler(callback({ code: "auth-code", state }, `vitehub_connection_state=${encodeURIComponent(state)}`))
    expect(failed.headers.get("location")).toBe("/settings?connection=gmail&outcome=failed")
    expect((await runtime.inspect("gmail")).status).toBe("disconnected")
  })

  it("uses / as the default return page", async () => {
    const context = setup()
    const handler = createConnectionsHandler({ authenticate: context.authenticate, runtime: context.runtime })
    const { state } = await startConnect(handler)

    const done = await handler(callback({ code: "auth-code", state }, `vitehub_connection_state=${encodeURIComponent(state)}`))
    expect(done.headers.get("location")).toBe("/")
  })

  it("returns 404 and 405 for other paths and methods", async () => {
    const { handler } = setup()
    expect((await handler(new Request(`${origin}/api/other`))).status).toBe(404)
    expect((await handler(new Request(`${base}/gmail`))).status).toBe(404)
    expect((await handler(new Request(`${base}/gmail/other`))).status).toBe(404)
    expect((await handler(new Request(`${base}/a/b/connect`))).status).toBe(404)
    expect((await handler(new Request(`${base}/%E0%A4%A/connect`))).status).toBe(404)
    expect((await handler(new Request(`${base}/gmail/connect?ticket=x`, { method: "POST" }))).status).toBe(405)
  })
})
