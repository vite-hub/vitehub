import { afterEach, describe, expect, it, vi } from "vitest"
import * as v from "valibot"

import { agentEnvAccess } from "../../env/test/agent-access.ts"
import { chatgptTransfers, chatgptTransferSchema } from "../src/internal/chatgpt-transfer.ts"
import { chatgpt } from "../src/chatgpt.ts"
import { defineConnection } from "../src/definition.ts"
import { useChatGPTCredential } from "../src/internal/agent-credential.ts"
import { chatgptHostId } from "../src/internal/chatgpt-host.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createConnectionsHandler } from "../src/http.ts"
import { createChatGPTFake } from "./chatgpt-fake.ts"
import { createStore } from "./helpers.ts"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(cleanup.splice(0).map(close => close()))
})

async function setup() {
  const clock = { now: Date.now() }
  const fake = await createChatGPTFake(() => clock.now)
  cleanup.push(() => fake.close())
  const store = createStore()
  const hostId = `urn:uuid:${crypto.randomUUID()}`
  const options = {
    definitions: { chatgpt: defineConnection({ provider: chatgpt({ appName: "My app" }), access: { "agent:assistant": { read: true } } }) },
    store, fetch: fake.fetch, now: () => clock.now, chatgptHostId: async () => hostId,
  }
  const runtime = createConnectionsRuntime(options)
  const authorize = () => runtime.authorize({ name: "chatgpt", redirectUri: "http://127.0.0.1:1455/callback" })
  const connect = async () => {
    const attempt = await authorize()
    const callback = await fake.callback(attempt.url)
    return await runtime.complete({ state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!, clientId: callback.searchParams.get("client_id") ?? undefined })
  }
  const use = (target = runtime) => useChatGPTCredential(target)("chatgpt", { access: agentEnvAccess({ name: "assistant" }) }, async credential => ({ expiresAt: credential.expiresAt, clientInfo: credential.clientInfo }))
  return { authorize, clock, connect, fake, hostId, options, runtime, store, use }
}

describe("ChatGPT plan Connections", () => {
  it("registers once and reuses the issued ID with fresh PKCE, state and nonce", async () => {
    const test = await setup()
    const first = await test.authorize()
    const second = await test.authorize()
    const firstUrl = new URL(first.url)
    const secondUrl = new URL(second.url)
    expect(Object.fromEntries(firstUrl.searchParams)).toMatchObject({ client_id: "dynamic_agent_client", agent_name_hint: "My app", ext_agent_host_id: test.hostId, resource: "https://api.openai.com/v1", code_challenge_method: "S256" })
    for (const field of ["state", "nonce", "code_challenge"]) expect(firstUrl.searchParams.get(field)).not.toBe(secondUrl.searchParams.get(field))
    const inspection = await test.connect()
    expect(inspection).toMatchObject({ account: { id: "test-account", email: "test@example.com" }, chatgpt: { clientId: "oaiapp_test_1", hostId: test.hostId, plan: "enabled" } })
    const next = new URL((await test.authorize()).url)
    expect(next.searchParams.get("client_id")).toBe("oaiapp_test_1")
    expect(next.searchParams.has("agent_name_hint")).toBe(false)
    expect(next.searchParams.has("id_token_hint")).toBe(false)
    await test.connect()
    expect(test.fake.state.registrations).toBe(1)
  })

  it.each(["identity", "account", "read", "persist"])("fences the old grant after a successful exchange followed by %s failure", async (failure) => {
    const test = await setup()
    await test.connect()
    const attempt = await test.authorize()
    const callback = await test.fake.callback(attempt.url)
    if (failure === "identity") test.fake.state.signWithWrongKey = true
    if (failure === "account") test.fake.state.subject = "other-account"
    const read = failure === "read" ? vi.spyOn(test.store.secrets, "read").mockRejectedValueOnce(new Error("read unavailable")) : undefined
    const persist = failure === "persist" ? vi.spyOn(test.store.state, "putForToken").mockRejectedValueOnce(new Error("state unavailable")) : undefined
    await expect(test.runtime.complete({ state: callback.searchParams.get("state")!, code: callback.searchParams.get("code")!, clientId: callback.searchParams.get("client_id") ?? undefined })).rejects.toThrow()
    read?.mockRestore()
    persist?.mockRestore()
    test.clock.now += 61_000
    await expect(test.use()).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
    expect(await test.runtime.inspect("chatgpt")).toMatchObject({ status: "reauth_required" })
    expect(test.fake.state.refreshes).toBe(0)
  })

  it("requires an explicit Agent access map and rejects generic credential use", async () => {
    expect(() => defineConnection({ provider: chatgpt({ appName: "Test" }) } as never)).toThrow()
    const test = await setup()
    await test.connect()
    await expect(test.runtime.client("chatgpt", {}).fetch("https://api.openai.com/v1/models")).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_CLIENT" })
    await expect(useChatGPTCredential(test.runtime)("chatgpt", { access: agentEnvAccess({ name: "other" }) }, async () => undefined)).rejects.toMatchObject({ code: "CONNECTIONS_DENIED" })
    await expect(test.use()).resolves.toMatchObject({ clientInfo: { name: "My app", title: "My app", version: "0.0.0" } })
    expect("getToken" in test.runtime).toBe(false)
    expect("useChatGPTCredential" in test.runtime).toBe(false)
  })

  it.each(["https://app.example/callback", "http://localhost:1455/callback", "http://127.0.0.1:1455/other"])("rejects the redirect %s", async (redirectUri) => {
    const test = await setup()
    await expect(test.runtime.authorize({ name: "chatgpt", redirectUri })).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_LOOPBACK" })
    expect(test.fake.calls).toHaveLength(0)
  })

  it("rejects a missing or mismatched callback client ID before exchange", async () => {
    const test = await setup()
    const attempt = await test.authorize()
    await expect(test.runtime.complete({ code: "code", state: attempt.state })).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_REGISTRATION" })
    await test.connect()
    const returning = await test.authorize()
    await expect(test.runtime.complete({ code: "code", state: returning.state, clientId: "oaiapp_different" })).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_REGISTRATION" })
    expect(test.fake.calls.filter(call => call.path.endsWith("/token"))).toHaveLength(1)
  })

  it("consumes denial state and rejects another manager", async () => {
    const test = await setup()
    const attempt = await test.authorize()
    await expect(test.runtime.complete({ error: "access_denied", state: attempt.state, actor: "user:other" })).rejects.toMatchObject({ code: "CONNECTIONS_FORBIDDEN" })
    await expect(test.runtime.complete({ error: "access_denied", state: attempt.state })).rejects.toMatchObject({ code: "CONNECTIONS_INVALID_REQUEST" })
    const denied = await test.authorize()
    await expect(test.runtime.complete({ error: "access_denied", state: denied.state })).rejects.toMatchObject({ code: "CONNECTIONS_AUTHORIZATION_CANCELLED" })
  })

  it("retains a valid identity-only grant but never spends without plan scopes", async () => {
    const test = await setup()
    test.fake.state.scopes = "openid profile email"
    expect(await test.connect()).toMatchObject({ status: "connected", chatgpt: { plan: "disabled" } })
    await expect(test.use()).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_PERMISSION" })
  })

  it("does not infer granted scopes when the token response omits them", async () => {
    const test = await setup()
    test.fake.state.omit = ["scope"]
    expect(await test.connect()).toMatchObject({ scopes: { granted: [] }, chatgpt: { plan: "disabled" } })
  })

  it("rotates once across runtimes and persists the replacement and inspection expiry", async () => {
    const test = await setup()
    await test.connect()
    const before = await test.store.secrets.read("connection/chatgpt")
    test.clock.now += 3_550_000
    const other = createConnectionsRuntime(test.options)
    await Promise.all([test.use(), test.use(other), test.use()])
    expect(test.fake.state.refreshes).toBe(1)
    const after = await test.store.secrets.read("connection/chatgpt")
    expect(after?.revision).not.toBe(before?.revision)
    expect((await test.runtime.inspect("chatgpt")).expiresAt).toBe(new Date(test.clock.now + 3_600_000).toISOString())
    const refresh = test.fake.calls.find(call => call.parameters.get("grant_type") === "refresh_token")
    expect(refresh?.parameters.get("client_id")).toBe("oaiapp_test_1")
    expect(refresh?.parameters.has("scope")).toBe(false)
  })

  it.each(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"])("clears unusable credentials for %s and retains registration", async (error) => {
    const test = await setup()
    await test.connect()
    test.clock.now += 3_550_000
    test.fake.state.tokenError = error
    await expect(test.use()).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
    const stored = await test.store.secrets.read("connection/chatgpt")
    expect(JSON.parse(stored!.value)).toEqual({ reauthRequired: true })
    expect(await test.runtime.inspect("chatgpt")).toMatchObject({ status: "reauth_required", chatgpt: { clientId: "oaiapp_test_1" } })
    expect(new URL((await test.authorize()).url).searchParams.get("client_id")).toBe("oaiapp_test_1")
  })

  it("preserves credentials but quarantines an ambiguous refresh failure", async () => {
    const test = await setup()
    await test.connect()
    test.clock.now += 3_550_000
    test.fake.state.tokenError = "test-secret-do-not-echo"
    test.fake.state.tokenStatus = 503
    const stored = await test.store.secrets.read("connection/chatgpt")
    const failure: unknown = await test.use().catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "CONNECTIONS_PROVIDER_FAILED" })
    expect(String(failure)).not.toContain("test-secret-do-not-echo")
    expect((await test.runtime.inspect("chatgpt")).status).toBe("reauth_required")
    expect(await test.store.secrets.read("connection/chatgpt")).toEqual(stored)
    test.fake.state.tokenError = undefined
    await expect(test.use()).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
    expect(test.fake.calls.filter(call => call.parameters.get("grant_type") === "refresh_token")).toHaveLength(1)
  })

  it("keeps a definite invalid-client rejection retryable", async () => {
    const test = await setup()
    await test.connect()
    test.clock.now += 3_550_000
    test.fake.state.tokenError = "invalid_client"
    await expect(test.use()).rejects.toMatchObject({ code: "CONNECTIONS_PROVIDER_FAILED" })
    expect((await test.runtime.inspect("chatgpt")).status).toBe("connected")
    test.fake.state.tokenError = undefined
    await expect(test.use()).resolves.toBeDefined()
  })

  it("retains the import fence after an ambiguous provider failure", async () => {
    const test = await setup()
    await test.connect()
    const credential = await chatgptTransfers(test.runtime).export({ name: "chatgpt", actor: "user:local" })
    const destination = createConnectionsRuntime({ ...test.options, store: createStore(), chatgptHostId: async () => "urn:uuid:destination" })
    test.fake.state.tokenError = "test-secret-do-not-echo"
    test.fake.state.tokenStatus = 503
    const input = { name: "chatgpt", actor: "user:local", credential }
    await expect(chatgptTransfers(destination).import(input)).rejects.toMatchObject({ code: "CONNECTIONS_PROVIDER_FAILED" })
    test.fake.state.tokenError = undefined
    test.clock.now += 61_000
    await expect(chatgptTransfers(destination).import(input)).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
    expect(test.fake.calls.filter(call => call.parameters.get("grant_type") === "refresh_token")).toHaveLength(1)
  })

  it("revokes the rotating refresh token with the issued client ID and keeps the host", async () => {
    const test = await setup()
    await test.connect()
    expect(await test.runtime.revoke({ name: "chatgpt" })).toMatchObject({ status: "revoked", chatgpt: { clientId: "oaiapp_test_1", hostId: test.hostId } })
    expect(test.fake.state.revoked).toBe(1)
    expect(JSON.parse((await test.store.secrets.read("connection/chatgpt"))!.value)).toEqual({ revoked: true })
    await test.connect()
    expect(test.fake.state.registrations).toBe(1)
  })

  it("never puts token material in inspection or activity", async () => {
    const test = await setup()
    await test.connect()
    await test.use()
    const visible = JSON.stringify([await test.runtime.inspect("chatgpt"), await test.runtime.list(), await test.runtime.activity({ name: "chatgpt" })])
    expect(visible).not.toMatch(/test-access-|test-refresh-|eyJ/)
  })

  it("refreshes before lending a token with fewer than fifteen minutes remaining", async () => {
    const test = await setup()
    await test.connect()
    test.clock.now += 2_750_000
    await test.use()
    expect(test.fake.state.refreshes).toBe(1)
  })

  it("moves refresh ownership, keeps the destination host and rotates on import", async () => {
    const test = await setup()
    await test.connect()
    const credential = await chatgptTransfers(test.runtime).export({ name: "chatgpt", actor: "user:local" })
    await expect(test.use()).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
    expect(JSON.parse((await test.store.secrets.read("connection/chatgpt"))!.value)).toEqual({ transferred: true })
    await test.runtime.revoke({ name: "chatgpt" })
    expect(test.fake.state.revoked).toBe(0)
    const destination = createConnectionsRuntime({ ...test.options, store: createStore(), chatgptHostId: async () => "urn:uuid:destination" })
    const result = await chatgptTransfers(destination).import({ name: "chatgpt", actor: "user:local", credential })
    expect(result).toMatchObject({ status: "connected", account: { email: "test@example.com" }, chatgpt: { hostId: "urn:uuid:destination", clientId: "oaiapp_test_1" } })
    expect(test.fake.state.refreshes).toBe(1)
    await expect(test.use(destination)).resolves.toBeDefined()
    await expect(chatgptTransfers(destination).import({ name: "chatgpt", actor: "user:local", credential })).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_TRANSFER" })
  })

  it.each([
    ["one public origin", "http://agent.example.com", { url: "https://agent.example.com" }],
    ["per-Agent public origin", "http://agent.example.com", { agents: { assistant: "https://agent.example.com" } }],
    ["internal proxy host", "http://internal:3000", { agents: { assistant: "https://agent.example.com" } }],
    ["direct HTTPS", "https://agent.example.com", undefined],
    ["IPv4 loopback", "http://127.0.0.1:5173", undefined],
    ["IPv6 loopback", "http://[::1]:5173", undefined],
    ["localhost", "http://localhost:5173", undefined],
  ])("transfers credentials through %s", async (_description, origin, publicUrl) => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", publicUrl)
    const test = await setup()
    await test.connect()
    const destination = createConnectionsRuntime({ ...test.options, store: createStore(), chatgptHostId: async () => "urn:uuid:destination" })
    const sourceHandler = createConnectionsHandler({ agentName: "assistant", actor: () => "user:local", runtime: () => test.runtime })
    const destinationHandler = createConnectionsHandler({ agentName: "assistant", actor: () => "user:local", runtime: () => destination })
    const post = (body: unknown) => new Request(`${origin}/_vitehub/connections`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: publicUrl ? "https://agent.example.com" : origin },
      body: JSON.stringify(body),
    })
    const exported = await sourceHandler(post({ action: "chatgpt-export", name: "chatgpt" }))
    expect(exported.status).toBe(200)
    const { credential } = v.parse(v.object({ credential: chatgptTransferSchema }), await exported.json())
    const imported = await destinationHandler(post({ action: "chatgpt-import", name: "chatgpt", credential }))
    expect(imported.status).toBe(200)
    expect(await imported.json()).toMatchObject({ connection: { status: "connected", chatgpt: { hostId: "urn:uuid:destination" } } })
    await expect(test.use()).rejects.toMatchObject({ code: "CONNECTIONS_NEEDS_RECONNECT" })
    await expect(test.use(destination)).resolves.toBeDefined()
    expect(test.fake.state.refreshes).toBe(1)
  })

  it.each(["chatgpt-export", "chatgpt-import"])("rejects %s over public HTTP despite forwarded HTTPS headers", async (action) => {
    const test = await setup()
    const handler = createConnectionsHandler({ actor: () => "user:local", runtime: () => test.runtime })
    const response = await handler(new Request("http://agent.example.com/_vitehub/connections", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https", forwarded: "proto=https" },
      body: JSON.stringify({ action, name: "chatgpt", credential: {} }),
    }))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "CONNECTIONS_FORBIDDEN" } })
  })

  it("verifies expired transfer identity before rotating and rejects a forged subject", async () => {
    const test = await setup()
    await test.connect()
    const credential = await chatgptTransfers(test.runtime).export({ name: "chatgpt", actor: "user:local" })
    test.clock.now += 4_000_000
    const destination = createConnectionsRuntime({ ...test.options, store: createStore() })
    await expect(chatgptTransfers(destination).import({ name: "chatgpt", actor: "user:local", credential: { ...credential, subject: "different-account" } })).rejects.toMatchObject({ code: "CONNECTIONS_CHATGPT_IDENTITY" })
    expect(test.fake.state.refreshes).toBe(0)
    await expect(chatgptTransfers(destination).import({ name: "chatgpt", actor: "user:local", credential })).resolves.toMatchObject({ status: "connected" })
  })

  it("lists only visible models without exposing tokens", async () => {
    const test = await setup()
    await test.connect()
    const models = await chatgptTransfers(test.runtime).models({ name: "chatgpt", actor: "user:local" })
    expect(models).toEqual([{ id: "gpt-6.1-sol", name: "GPT-6.1" }])
  })

  it("creates one durable host identity across concurrent runtimes", async () => {
    const store = createStore()
    const ids = await Promise.all(Array.from({ length: 5 }, () => chatgptHostId(store.secrets)))
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toMatch(/^urn:uuid:/)
    expect(await chatgptHostId(store.secrets)).toBe(ids[0])
    expect(await chatgptHostId(createStore().secrets)).not.toBe(ids[0])
  })
})
