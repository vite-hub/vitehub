import { describe, expect, it } from "vitest"
import { agentEnvAccess } from "../../env/test/agent-access.ts"

import { apiKey } from "../src/api-key.ts"
import { runConnectionsCli } from "../src/cli.ts"
import { defineConnection } from "../src/definition.ts"
import { createConnectionsHandler } from "../src/http.ts"
import { createConnectionsRuntime } from "../src/runtime.ts"
import { createStore } from "./helpers.ts"

import type { ConnectionApiKeyProvider, ConnectionDefinition } from "../src/types.ts"

const KEY = "sk_live_secret_key_1"

interface Call {
  body?: string
  headers: Headers
  method: string
  redirect?: RequestInit["redirect"]
  url: string
}

interface ItemsApi {
  "items.list": { method: "GET", body: never, params: object, response: { items: string[] } }
  "items.create": { method: "POST", body: { name: string }, params: object, response: { id: string } }
}

function harness(provider: ConnectionApiKeyProvider = apiKey({ origins: ["https://api.example.com"] }), access?: ConnectionDefinition["access"]) {
  const calls: Call[] = []
  const routes = new Map<string, () => Response>()
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString()
    calls.push({ ...(init?.body ? { body: String(init.body) } : {}), headers: new Headers(init?.headers), method: init?.method ?? "GET", redirect: init?.redirect, url })
    const route = routes.get(url)
    if (route) return route()
    return Response.json({ items: ["a"] })
  }
  const definition = defineConnection({ provider, ...(access ? { access } : {}) })
  const store = createStore()
  const runtime = createConnectionsRuntime({ definitions: { executor: definition }, fetch: fetcher, store })
  return { calls, routes, runtime, store }
}

describe("apiKey()", () => {
  it("defaults to a Bearer authorization header", () => {
    expect(apiKey({ origins: ["https://API.example.com:443"] })).toMatchObject({ header: "authorization", id: "api-key", kind: "api-key", origins: ["https://api.example.com"], scheme: "Bearer" })
    expect(apiKey({ header: "X-Api-Key", origins: ["http://localhost:8787"] })).toMatchObject({ header: "x-api-key", origins: ["http://localhost:8787"] })
    expect(apiKey({ origins: ["https://api.example.com"], scheme: "" })).not.toHaveProperty("scheme")
  })

  it.each([
    { origins: [] },
    { origins: ["http://api.example.com"] },
    { origins: ["https://api.example.com/v1"] },
    { origins: ["https://user:pass@api.example.com"] },
    { header: "bad header", origins: ["https://api.example.com"] },
    { origins: ["https://api.example.com"], scheme: "Bad Scheme" },
    { id: "has space", origins: ["https://api.example.com"] },
    { apis: { items: { methods: {}, rootUrl: "http://api.example.com" } }, origins: ["https://api.example.com"] },
    { apis: { items: { methods: {}, rootUrl: "https://api.example.com/v1" } }, origins: ["https://api.example.com"] },
  ])("rejects an unsafe provider (%o)", (options) => {
    expect(() => apiKey(options)).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID" }))
  })

  it("rejects scopes and hand-written providers that would send the key over plain HTTP", () => {
    // @ts-expect-error API keys have no scopes.
    expect(() => defineConnection({ provider: apiKey({ origins: ["https://api.example.com"] }), scopes: ["read"] })).toThrow()
    expect(() => defineConnection({ provider: { apis: {}, header: "authorization", id: "plain", kind: "api-key", origins: ["http://api.example.com"] } })).toThrow()
  })
})

describe("API key Connections", () => {
  it("stores a key, sends it only in the provider header, and never returns it", async () => {
    const test = harness(apiKey({ header: "x-api-key", origins: ["https://api.example.com"] }))
    expect(await test.runtime.inspect("executor")).toMatchObject({ credential: "api-key", scopes: { declared: [], missing: [] }, status: "disconnected" })
    const connection = await test.runtime.setKey({ actor: "user:ada", key: KEY, name: "executor" })
    expect(connection).toMatchObject({ credential: "api-key", status: "connected" })
    expect(JSON.stringify(connection)).not.toContain(KEY)

    const response = await test.runtime.client("executor", {}).fetch("https://api.example.com/items", { headers: { "X-Api-Key": "caller-value", authorization: "Bearer caller" } })
    expect(response.status).toBe(200)
    expect(test.calls.at(-1)!.headers.get("x-api-key")).toBe(KEY)
    expect(test.calls.at(-1)!.headers.get("authorization")).toBeNull()
    await expect(test.runtime.client("executor", {}).fetch("https://other.example.com/items")).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect(test.calls).toHaveLength(1)
    const activity = await test.runtime.activity({ name: "executor" })
    expect(activity.map(entry => entry.action)).toEqual(expect.arrayContaining(["replace", "use"]))
    expect(JSON.stringify(activity)).not.toContain(KEY)
  })

  it("quarantines a key when its state cannot be persisted", async () => {
    const test = harness()
    const putForToken = test.store.state.putForToken
    let failures = 1
    test.store.state.putForToken = async (...args) => {
      if (failures--) throw new Error("state unavailable")
      return putForToken(...args)
    }
    await expect(test.runtime.setKey({ key: KEY, name: "executor" })).rejects.toThrow("state unavailable")
    expect(await test.runtime.inspect("executor")).toMatchObject({ status: "reauth_required" })
  })

  it("retains the mutation lease when post-persistence inspection fails", async () => {
    const test = harness()
    const get = test.store.state.get
    let calls = 0
    test.store.state.get = async name => {
      if (++calls === 1) throw new Error("state inspection unavailable")
      return get(name)
    }
    await expect(test.runtime.setKey({ key: KEY, name: "executor" })).rejects.toThrow("state inspection unavailable")
    test.store.state.get = get
    const stored = await test.store.secrets.inspect("connection/executor")
    expect(stored?.revision).toBeTruthy()
    expect(await test.store.refreshLeases.claim({ expiresAt: Date.now() + 60_000, name: "executor", now: Date.now(), owner: "other", revision: stored!.revision })).toBe("busy")
    expect(await test.runtime.inspect("executor")).toMatchObject({ status: "reauth_required" })
  })

  it("calls typed catalog methods with the scheme and key", async () => {
    const provider = apiKey<{ items: ItemsApi }>({
      apis: { items: { methods: { "items.create": ["POST", "v1/items", true], "items.list": ["GET", "v1/items", false] }, rootUrl: "https://api.example.com/" } },
      origins: ["https://api.example.com"],
      scheme: "Token",
    })
    const test = harness(provider)
    await test.runtime.setKey({ key: KEY, name: "executor" })
    expect(await test.runtime.client("executor", {}).call("items.items.list")).toEqual({ items: ["a"] })
    expect(test.calls.at(-1)!.headers.get("authorization")).toBe(`Token ${KEY}`)
    expect((await test.runtime.inspect("executor")).actions.map(action => action.id)).toEqual(["items.items.create", "items.items.list"])
  })

  it("does not refresh or quarantine a key that the provider rejects", async () => {
    const test = harness()
    await test.runtime.setKey({ key: KEY, name: "executor" })
    test.routes.set("https://api.example.com/items", () => new Response(null, { status: 401 }))
    expect((await test.runtime.client("executor", {}).fetch("https://api.example.com/items")).status).toBe(401)
    expect(test.calls).toHaveLength(1)
    expect((await test.runtime.inspect("executor")).status).toBe("connected")
  })

  it("removes the key when a redirect leaves the first origin", async () => {
    const test = harness(apiKey({ header: "x-api-key", origins: ["https://api.example.com"] }))
    await test.runtime.setKey({ key: KEY, name: "executor" })
    test.routes.set("https://api.example.com/start", () => new Response(null, { headers: { location: "/next" }, status: 307 }))
    test.routes.set("https://api.example.com/next", () => new Response(null, { headers: { location: "https://evil.example.net/steal" }, status: 302 }))
    test.routes.set("https://evil.example.net/steal", () => new Response(null, { headers: { location: "https://api.example.com/back" }, status: 302 }))
    const response = await test.runtime.client("executor", {}).fetch("https://api.example.com/start", { headers: { cookie: "session=secret" } })
    expect(response.status).toBe(200)
    expect(test.calls.map(call => [call.url, call.headers.get("x-api-key"), call.headers.get("cookie"), call.redirect])).toEqual([
      ["https://api.example.com/start", KEY, "session=secret", "manual"],
      ["https://api.example.com/next", KEY, "session=secret", "manual"],
      ["https://evil.example.net/steal", null, null, "manual"],
      ["https://api.example.com/back", null, null, "manual"],
    ])
  })

  it("verifies a key before storing it", async () => {
    const seen: string[] = []
    const test = harness(apiKey({
      origins: ["https://api.example.com"],
      verify: async (key, context) => {
        seen.push(key)
        const response = await context.fetch("https://api.example.com/me", { headers: { authorization: `Bearer ${key}` }, signal: context.signal })
        return response.ok && key === KEY ? { account: { email: "ada@example.com", id: "acct_1" } } : false
      },
    }))
    await expect(test.runtime.setKey({ key: "wrong-key", name: "executor" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    expect((await test.runtime.inspect("executor")).status).toBe("disconnected")
    expect(await test.runtime.setKey({ key: KEY, name: "executor" })).toMatchObject({ account: { email: "ada@example.com", id: "acct_1" }, status: "connected" })
    expect(seen).toEqual(["wrong-key", KEY])
  })

  it("hides verify failures that could contain the key", async () => {
    const throwing = harness(apiKey({ origins: ["https://api.example.com"], verify: async key => { throw new Error(`bad ${key}`) } }))
    const error = await throwing.runtime.setKey({ key: KEY, name: "executor" }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: "CONNECTION_PROVIDER" })
    expect(String(error)).not.toContain(KEY)
    // SAFETY: The test checks that a verify result outside the declared type is rejected at runtime.
    const invalid = harness(apiKey({ origins: ["https://api.example.com"], verify: (async () => "yes") as unknown as () => Promise<boolean> }))
    await expect(invalid.runtime.setKey({ key: KEY, name: "executor" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
  })

  it.each(["", "has space", "line\nbreak", "k".repeat(8193)])("rejects a key that is not a header value (%j)", async (key) => {
    await expect(harness().runtime.setKey({ key, name: "executor" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
  })

  it("keeps OAuth and API key flows separate", async () => {
    const test = harness()
    await expect(test.runtime.authorize({ name: "executor", redirectUri: "http://127.0.0.1:8976/callback" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
    const { createTestRuntime } = await import("./helpers.ts")
    await expect(createTestRuntime().runtime.setKey({ key: KEY, name: "mail" })).rejects.toMatchObject({ code: "CONNECTION_INVALID" })
  })

  it("revokes by deleting the stored key", async () => {
    const test = harness()
    await test.runtime.setKey({ key: KEY, name: "executor" })
    expect(await test.runtime.revoke({ name: "executor" })).toMatchObject({ status: "revoked" })
    expect(test.calls).toHaveLength(0)
    await expect(test.runtime.client("executor", {}).fetch("https://api.example.com/items")).rejects.toMatchObject({ code: "CONNECTION_REAUTH_REQUIRED" })
    expect(await test.runtime.setKey({ key: KEY, name: "executor" })).toMatchObject({ status: "connected" })
  })

  it("applies access rules and replays approved writes with the current key", async () => {
    const test = harness(apiKey({ origins: ["https://api.example.com"] }), { "agent:support": { read: true, write: ["fetch"] } })
    await test.runtime.setKey({ key: KEY, name: "executor" })
    const agent = test.runtime.client("executor", { access: agentEnvAccess({ name: "support" }) })
    const error = await agent.fetch("https://api.example.com/items", { body: "{}", method: "POST" }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: "CONNECTION_APPROVAL_REQUIRED" })
    await expect(test.runtime.client("executor", { actor: "server" }).fetch("https://api.example.com/items")).rejects.toMatchObject({ code: "CONNECTION_DENIED" })
    const [approval] = (await test.runtime.approvals({ name: "executor", status: "pending" })).approvals
    expect(await test.runtime.approve({ id: approval!.id })).toMatchObject({ approval: { status: "executed" }, result: { status: 200 } })
    expect(test.calls.at(-1)).toMatchObject({ body: "{}", method: "POST", url: "https://api.example.com/items" })
    expect(test.calls.at(-1)!.headers.get("authorization")).toBe(`Bearer ${KEY}`)
  })

  it("skips writes in dry run", async () => {
    const test = harness(apiKey({ origins: ["https://api.example.com"] }), { server: { read: true, write: ["fetch"] } })
    await test.runtime.setKey({ key: KEY, name: "executor" })
    const effects: unknown[] = []
    const response = await test.runtime.client("executor", { dryRun: true, onEffect: effect => effects.push(effect) }).fetch("https://api.example.com/items", { method: "DELETE" })
    expect(response.status).toBe(204)
    expect(effects).toEqual([expect.objectContaining({ kind: "fetch", skipped: "dry-run" })])
    expect(test.calls).toHaveLength(0)
  })
})

describe("API key management", () => {
  const origin = "http://localhost:5173"

  function cli(test = harness(), stdin: AsyncIterable<string> & { isTTY?: boolean } = (async function* () { yield `${KEY}\n` })()) {
    const handler = createConnectionsHandler({ actor: () => "user:ada", runtime: () => test.runtime })
    const requests: RequestInit[] = []
    const output = { stderr: "", stdout: "" }
    const context = {
      env: {},
      stderr: { write: (chunk: string | Uint8Array) => (output.stderr += String(chunk)) },
      stdout: { write: (chunk: string | Uint8Array) => (output.stdout += String(chunk)) },
    }
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(init ?? {})
      return await handler(new Request(input, init))
    }
    return { output, requests, run: (args: string[]) => runConnectionsCli("set-key", args, context, { fetch: fetcher, stdin }) }
  }

  it("sets the key through the management route", async () => {
    const test = harness()
    const handler = createConnectionsHandler({ actor: () => "user:ada", runtime: () => test.runtime })
    const response = await handler(new Request(`${origin}/_vitehub/connections`, {
      body: JSON.stringify({ action: "set-key", key: KEY, name: "executor" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }))
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({ connection: { credential: "api-key", status: "connected" } })
    expect(body).not.toContain(KEY)
  })

  it("reads the key from stdin and refuses redirects", async () => {
    const harnessCli = cli()
    expect(await harnessCli.run(["executor", "--json"])).toBe(0)
    expect(JSON.parse(harnessCli.output.stdout)).toMatchObject({ credential: "api-key", status: "connected" })
    expect(harnessCli.requests[0]).toMatchObject({ redirect: "error" })
    expect(harnessCli.output.stdout + harnessCli.output.stderr).not.toContain(KEY)
  })

  it("refuses a terminal, an empty key, and a remote plain HTTP app", async () => {
    const terminal = cli(harness(), Object.assign((async function* () {})(), { isTTY: true }))
    expect(await terminal.run(["executor"])).toBe(1)
    expect(terminal.output.stderr).toContain("Pipe the key on stdin")
    const empty = cli(harness(), (async function* () { yield "\n" })())
    expect(await empty.run(["executor"])).toBe(1)
    expect(empty.output.stderr).toContain("empty")
    const remote = cli()
    expect(await remote.run(["executor", "--url", "http://app.example.com"])).toBe(1)
    expect(remote.output.stderr).toContain("only over HTTPS")
    expect(remote.requests).toHaveLength(0)
  })
})
