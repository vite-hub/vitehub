import { once } from "node:events"
import { createServer, request as httpRequest } from "node:http"

import { consoleCallerHeader, consoleSignatureHeader } from "@vite-hub/internal/console-signature"
import { callOperationRpc, operationRpcPath } from "@vite-hub/internal/operation-rpc"
import { callOperation, defineOperation, installedOperationSectionResolver } from "@vite-hub/internal/operations"
import { defineHandler, H3, toNodeHandler } from "h3"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"

import { forwardProjectRequest } from "../../console/src/forward.ts"
import { consoleCallerOf, consoleCallerUser } from "../../console/src/caller.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleCaller } from "@vite-hub/internal/console-signature"
import type { OperationContext } from "@vite-hub/internal/operations"
import type { ConsoleAuthorize, ConsoleAuthorizeContext } from "../src/console/auth-types.ts"

const app = "https://app.example.com"
const ci = await consoleTestKey("CI")
const link = await consoleTestKey("CONSOLE_3F9A12BC")
const person: ConsoleCaller = { team: { id: "team-1", role: "owner" }, user: { email: "ada@example.com", id: "user-1", name: "Ada" }, via: "console" }

// An operation that tells who called it, as an app's own operation reads `context.user`.
const whoami = defineOperation<Record<string, never>, { surface: OperationContext["surface"], user: OperationContext["user"] }>({
  description: "Who calls.",
  input: v.object({}),
  kind: "read",
  name: "test.whoami",
  run: async (_input, context) => ({ surface: context.surface, user: context.user }),
  section: false,
})

// The operations of the MCP tests: one that MCP clients may not call, one that deletes, and one with a large input.
const hidden = defineOperation<Record<string, never>, string>({
  description: "Only for the Console page.",
  input: v.object({}),
  kind: "write",
  name: "test.hidden",
  run: async () => "ran",
  section: false,
  mcp: false,
})
const drop = defineOperation<{ key: string }, { dropped: string }>({
  description: "Delete one key.",
  input: v.object({ key: v.string() }),
  kind: "destructive",
  name: "test.drop",
  run: async ({ key }) => ({ dropped: key }),
  section: false,
})
const store = defineOperation<{ text: string }, { bytes: number }>({
  description: "Store a large text.",
  input: v.object({ text: v.string() }),
  kind: "write",
  maxRequestBytes: 1024 * 1024,
  name: "test.store",
  run: async ({ text }) => ({ bytes: text.length }),
  section: false,
})

function install(authorize?: ConsoleAuthorize): void {
  installConsoleAccess({ mode: "token", ...(authorize ? { authorize } : {}) })
  installConsoleOperations([{ operations: [whoami, hidden, drop, store], plugin: "test" }])
}

function send(request: Request): Promise<Response> {
  return defineHandler(consoleRpcHandler).fetch(request)
}

function stubKeys(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  installConsoleOperations([])
  // The other Console tests run as the local development server.
  installConsoleAccess({ mode: "open" })
})

describe("signed Console requests", () => {
  it.each([undefined, "http://production.example.com"])("rejects preview replays through the Node adapter with publicUrl %s", async (publicUrl) => {
    stubKeys(ci.env)
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", publicUrl ? { url: publicUrl } : undefined)
    install()
    const server = createServer(toNodeHandler(new H3().all("/**", consoleRpcHandler)))
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Expected a TCP address.")
      const sendToNode = async (signed: Request, host: string): Promise<Response> => {
        const body = await signed.text()
        return new Promise((resolve, reject) => {
          const request = httpRequest({
            headers: { ...Object.fromEntries(signed.headers), host, "x-forwarded-host": "preview.example.com", "x-forwarded-proto": "https" },
            hostname: "127.0.0.1", method: "POST", path: "/_vitehub/rpc", port: address.port,
          }, (response) => {
            let text = ""
            response.setEncoding("utf8")
            response.on("data", (chunk: string) => { text += chunk })
            response.on("end", () => resolve(new Response(text, { status: response.statusCode })))
            response.on("error", reject)
          })
          request.on("error", reject)
          request.end(body)
        })
      }
      const signed = await signedRpcRequest({ key: ci.key, url: "http://preview.example.com/_vitehub/rpc" })
      for (const host of ["preview.example.com", "production.example.com"]) {
        const response = await sendToNode(signed.clone(), host)
        expect(response.status, await response.clone().text()).toBe(publicUrl ? 401 : 500)
        await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_SIGNATURE_ORIGIN" })
      }
      if (publicUrl) {
        const response = await sendToNode(await signedRpcRequest({ key: ci.key, url: `${publicUrl}/_vitehub/rpc` }), "production.example.com")
        expect(response.status, await response.clone().text()).toBe(200)

        // A Console linking itself signs for its public URL, while Node runs behind a proxy.
        stubKeys(link.env)
        const page = new Request(`${publicUrl}/p/self/_vitehub/rpc`, { body: operationRpcBody("test.whoami", {}), headers: { "content-type": "application/json", [consoleRpcHeader]: "1" }, method: "POST" })
        const selfLink = await forwardProjectRequest(page, { caller: person, key: link.key, url: publicUrl }, "/_vitehub/rpc", (url, init) => sendToNode(new Request(url, init), "127.0.0.1"))
        expect(selfLink.status, await selfLink.clone().text()).toBe(200)
        await expect(operationRpcResponseResult(selfLink)).resolves.toMatchObject({ ok: true, value: { surface: "console", user: { email: "ada@example.com" } } })
      }
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it("accepts a request that the CLI signed with a key in VITEHUB_CONSOLE_KEY_<NAME>", async () => {
    stubKeys({ ...ci.env, ...link.env })
    install()
    const response = await send(await signedRpcRequest({ key: ci.key, operation: "test.whoami" }))
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(operationRpcResponseResult(response)).resolves.toEqual({ ok: true, value: { surface: "cli", user: null } })
  })

  it("reads the keys from the Cloudflare env of the request too", async () => {
    install()
    const request = Object.assign(await signedRpcRequest({ key: link.key }), {
      runtime: { name: "cloudflare", cloudflare: { context: { passThroughOnException: vi.fn(), waitUntil: vi.fn() }, env: { DB: {}, ...link.env } } },
    })
    expect((await send(request)).status).toBe(200)
  })

  const now = Date.now()
  it.each([
    ["an unsigned request", "CONSOLE_SIGNATURE_MISSING", async () => new Request(`${app}/_vitehub/rpc`, { body: operationRpcBody("sections.list", {}), headers: { "content-type": "application/json", [consoleRpcHeader]: "1" }, method: "POST" })],
    ["a bearer token and a cookie", "CONSOLE_SIGNATURE_MISSING", async () => new Request(`${app}/_vitehub/rpc`, { body: operationRpcBody("sections.list", {}), headers: { authorization: "Bearer test-console-token-0123456789abcdef", "content-type": "application/json", cookie: "better-auth.session_token=abc", [consoleRpcHeader]: "1" }, method: "POST" })],
    ["a signature from 6 minutes ago", "CONSOLE_SIGNATURE_STALE", () => signedRpcRequest({ key: ci.key, now: now - 6 * 60_000 })],
    ["a signature 6 minutes in the future", "CONSOLE_SIGNATURE_STALE", () => signedRpcRequest({ key: ci.key, now: now + 6 * 60_000 })],
    ["a signature for another origin", "CONSOLE_SIGNATURE_ORIGIN", async () => {
      const signed = await signedRpcRequest({ key: ci.key, url: "https://other.example.com/_vitehub/rpc" })
      return new Request(`${app}/_vitehub/rpc`, { body: await signed.text(), headers: signed.headers, method: "POST" })
    }],
    ["a changed body", "CONSOLE_SIGNATURE_BODY", async () => {
      const signed = await signedRpcRequest({ input: {}, key: ci.key, operation: "sections.list" })
      return new Request(signed.url, { body: operationRpcBody("test.whoami", {}), headers: signed.headers, method: "POST" })
    }],
    ["a key name that the app does not know", "CONSOLE_KEY_UNKNOWN", () => signedRpcRequest({ key: { ...ci.key, name: "OTHER" } })],
    ["a signature from another key", "CONSOLE_SIGNATURE_INVALID", () => signedRpcRequest({ key: { ...link.key, name: "CI" } })],
    ["a changed person", "CONSOLE_SIGNATURE_INVALID", async () => {
      const signed = await signedRpcRequest({ caller: person, key: link.key })
      const headers = new Headers(signed.headers)
      headers.set(consoleCallerHeader, Buffer.from(JSON.stringify({ ...person, user: { id: "admin" } })).toString("base64url"))
      return new Request(signed.url, { body: await signed.text(), headers, method: "POST" })
    }],
    ["a signature for another path", "CONSOLE_SIGNATURE_INVALID", async () => {
      const signed = await signedRpcRequest({ key: ci.key, url: `${app}/portal/_vitehub/rpc` })
      return new Request(`${app}/_vitehub/rpc`, { body: await signed.text(), headers: signed.headers, method: "POST" })
    }],
    ["a malformed signature header", "CONSOLE_SIGNATURE_INVALID", async () => {
      const signed = await signedRpcRequest({ key: ci.key })
      const headers = new Headers(signed.headers)
      headers.set(consoleSignatureHeader, `${signed.headers.get(consoleSignatureHeader)}, key=CI`)
      return new Request(signed.url, { body: await signed.text(), headers, method: "POST" })
    }],
  ] satisfies Array<[string, string, () => Promise<Request>]>)("refuses %s with 401 and %s", async (_name, code, request) => {
    stubKeys({ ...ci.env, ...link.env })
    const authorize = vi.fn(() => true)
    install(authorize)
    const response = await send(await request())
    expect(response.status).toBe(401)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code, docs: expect.stringContaining("#sign-console-requests"), fix: expect.any(String), ok: false, status: 401 })
    // The body check runs in the RPC route, after `authorize`, on the bytes that it reads. Every other refusal comes
    // from the access check, before `authorize`, with the signature challenge.
    if (code === "CONSOLE_SIGNATURE_BODY") return
    expect(response.headers.get("www-authenticate")).toBe("VitehubSignature realm=\"vitehub-console\"")
    expect(authorize).not.toHaveBeenCalled()
  })

  it.each([
    ["no key is set", {}, "CONSOLE_KEY_NOT_CONFIGURED", "none is set"],
    ["a key is blank", { VITEHUB_CONSOLE_KEY_CI: "   " }, "CONSOLE_KEY_NOT_CONFIGURED", "none is set"],
    ["a key is hex", { VITEHUB_CONSOLE_KEY_CI: "ab".repeat(32) }, "CONSOLE_KEY_MALFORMED", "`VITEHUB_CONSOLE_KEY_CI` is not an Ed25519 public key"],
    ["a key has padding", { VITEHUB_CONSOLE_KEY_CI: `${ci.publicKey}=` }, "CONSOLE_KEY_MALFORMED", "`VITEHUB_CONSOLE_KEY_CI`"],
    ["a key is 31 bytes", { VITEHUB_CONSOLE_KEY_CI: Buffer.alloc(31, 1).toString("base64url") }, "CONSOLE_KEY_MALFORMED", "`VITEHUB_CONSOLE_KEY_CI`"],
    ["a name has lowercase letters", { ...ci.env, VITEHUB_CONSOLE_KEY_lower: ci.publicKey }, "CONSOLE_KEY_MALFORMED", "`VITEHUB_CONSOLE_KEY_lower`"],
  ] satisfies Array<[string, Record<string, string>, string, string]>)("refuses every request with a 500 diagnostic when %s", async (_name, env, code, message) => {
    stubKeys(env)
    install()
    const response = await send(await signedRpcRequest({ key: ci.key }))
    expect(response.status).toBe(500)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code, fix: expect.stringContaining("vitehub secret console-key"), message: expect.stringContaining(message) })
  })

  it("gives authorize and operations the person that the Console signed, with via: \"console\"", async () => {
    stubKeys(link.env)
    const seen: ConsoleAuthorizeContext[] = []
    install((context) => {
      seen.push(context)
      // The union narrows: a Console caller always has a user.
      if (context.via === "console") return context.user.id === "user-1"
      return false
    })
    const response = await send(await signedRpcRequest({ caller: person, key: link.key, operation: "test.whoami" }))
    await expect(operationRpcResponseResult(response)).resolves.toEqual({ ok: true, value: { surface: "console", user: { email: "ada@example.com", id: "user-1", name: "Ada" } } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ key: "CONSOLE_3F9A12BC", team: { id: "team-1", role: "owner" }, user: { email: "ada@example.com", id: "user-1", name: "Ada" }, via: "console" })
    expect(seen[0]?.request.headers.has(consoleSignatureHeader)).toBe(true)
  })

  it("gives authorize via: \"cli\" and no user for a CLI key, and lets it limit the sections", async () => {
    stubKeys(ci.env)
    const seen: ConsoleAuthorizeContext[] = []
    install((context) => {
      seen.push(context)
      return context.via === "cli" ? { sections: ["kv"] } : false
    })
    const response = await send(await signedRpcRequest({ key: ci.key }))
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ ok: true, value: { scoped: true } })
    expect(seen[0]).toMatchObject({ key: "CI", via: "cli" })
    expect(seen[0]).not.toHaveProperty("user")
  })

  it("never gives an Agent's operation calls a signed context", async () => {
    // A policy that trusts `via: "console"` or `via: "cli"` must not reach Agents: they send no signature.
    const authorize = vi.fn((context: ConsoleAuthorizeContext) => context.via === "console" || context.via === "cli" ? { sections: ["kv"] } : false)
    install(authorize)
    await expect(installedOperationSectionResolver()?.({ user: null })).resolves.toEqual([])
    expect(authorize.mock.calls[0]?.[0]).toMatchObject({ via: "agent" })
    expect(authorize.mock.calls[0]?.[0]).not.toHaveProperty("user")
  })

  it("gives an Agent's operation calls the agent context with the user it acts for", async () => {
    const authorize = vi.fn((context: ConsoleAuthorizeContext) => context.via === "agent" ? { sections: ["kv:read"] } : false)
    install(authorize)
    await expect(installedOperationSectionResolver()?.({ user: { id: "agent-user" } })).resolves.toEqual(["kv:read"])
    expect(authorize.mock.calls[0]?.[0]).toMatchObject({ user: { id: "agent-user" }, via: "agent" })
  })

  it("lets signed requests reach only POST /_vitehub/rpc", async () => {
    stubKeys(ci.env)
    install()
    installConsoleSections("/console-signature-auth", ["auth"])
    const signed = await signedRpcRequest({ body: JSON.stringify({ action: "stopImpersonating" }), key: ci.key, url: `${app}/_vitehub/rpc/__call` })
    const response = await defineHandler(consoleRpcHandler).fetch(signed)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_SIGNATURE_INVALID", message: "Signed requests reach only POST /_vitehub/rpc." })
  })
})

describe("signed callers", () => {
  it.each([513, 1024])("accepts an account name of %s characters through the forwarder and RPC", async (length) => {
    stubKeys(link.env)
    install()
    const caller = consoleCallerOf({
      user: consoleCallerUser({ email: "ada@example.com", id: "user-1", name: "a".repeat(length) }),
      roles: ["owner"], teamId: "team-1",
    })
    const page = new Request("https://console.vitehub.dev/p/1/_vitehub/rpc", {
      body: operationRpcBody("test.whoami", {}),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" }, method: "POST",
    })
    const response = await forwardProjectRequest(page, { caller, key: link.key, url: app }, "/_vitehub/rpc", (url, init) => send(new Request(url, init)))
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(operationRpcResponseResult(response)).resolves.toEqual({ ok: true, value: { surface: "console", user: { email: "ada@example.com", id: "user-1" } } })
  })

  it("the Console forwarder signs a call for the person, and the app accepts it", async () => {
    stubKeys(link.env)
    const seen: ConsoleAuthorizeContext[] = []
    install((context) => {
      seen.push(context)
      return true
    })
    const page = new Request("https://console.vitehub.dev/p/1/_vitehub/rpc", {
      body: operationRpcBody("test.whoami", {}),
      headers: { "content-type": "application/json", cookie: "console=1", [consoleRpcHeader]: "1" },
      method: "POST",
    })
    const response = await forwardProjectRequest(page, { caller: person, key: link.key, url: app }, "/_vitehub/rpc", (url, init) => send(new Request(url, init)))
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(operationRpcResponseResult(response)).resolves.toEqual({ ok: true, value: { surface: "console", user: { email: "ada@example.com", id: "user-1", name: "Ada" } } })
    expect(seen[0]).toMatchObject({ key: "CONSOLE_3F9A12BC", via: "console" })
  })

  it("the Console forwarder keeps a mount prefix in the signed path", async () => {
    stubKeys(link.env)
    install()
    const page = new Request("https://console.vitehub.dev/p/1/_vitehub/rpc", { body: operationRpcBody("sections.list", {}), headers: { "content-type": "application/json", [consoleRpcHeader]: "1" }, method: "POST" })
    const response = await forwardProjectRequest(page, { caller: person, key: link.key, url: `${app}/portal` }, "/_vitehub/rpc", (url, init) => send(new Request(url, init)))
    expect(response.status, await response.clone().text()).toBe(200)
  })

  it("the CLI signs with VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> when it calls --url", async () => {
    stubKeys(ci.env)
    install()
    const result = await callOperation({
      env: { [`VITEHUB_CONSOLE_PRIVATE_KEY_${ci.key.name}`]: ci.key.privateKey },
      fetch: async (url, init) => send(new Request(url, init)),
      url: app,
    }, "test.whoami", {})
    expect(result).toEqual({ ok: true, value: { surface: "cli", user: null } })
    const unsigned = await callOperation({ env: {}, fetch: async (url, init) => send(new Request(url, init)), url: app }, "test.whoami", {})
    expect(unsigned).toMatchObject({ code: "CONSOLE_SIGNATURE_MISSING", fix: expect.stringContaining("vitehub secret console-key"), ok: false, status: 401 })
  })

  it("the CLI refuses a malformed private key or two keys before it sends anything", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(callOperation({ env: { VITEHUB_CONSOLE_PRIVATE_KEY_CI: "not-a-key" }, fetch, url: app }, "test.whoami", {})).resolves.toMatchObject({ message: expect.stringContaining("VITEHUB_CONSOLE_PRIVATE_KEY_CI must be the 43-character private key"), ok: false })
    await expect(callOperation({ env: { VITEHUB_CONSOLE_PRIVATE_KEY_A: ci.key.privateKey, VITEHUB_CONSOLE_PRIVATE_KEY_B: link.key.privateKey }, fetch, url: app }, "test.whoami", {})).resolves.toMatchObject({ message: expect.stringContaining("Set one VITEHUB_CONSOLE_PRIVATE_KEY_<NAME> variable"), ok: false })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("calls of the ViteHub MCP in the Console", () => {
  const mcpCaller = (confirmed = false): ConsoleCaller => ({ ...person, surface: "mcp", ...(confirmed ? { confirmed: true } : {}) })

  /** One operation call as the Console MCP sends it: birpc framing, then the Console forwarder signs it. */
  async function callAsMcp(name: string, input: unknown, caller: ConsoleCaller = mcpCaller()) {
    return callOperationRpc(name, input, async (body) => {
      const call = new Request("https://console.invalid/", { body, headers: { "content-type": "application/json", [consoleRpcHeader]: "1" }, method: "POST" })
      const response = await forwardProjectRequest(call, { caller, key: link.key, url: app }, operationRpcPath, (url, init) => send(new Request(url, init)))
      return { body: await response.json().catch(() => undefined), response }
    })
  }

  it("runs operations with the mcp surface and tells authorize", async () => {
    stubKeys(link.env)
    const seen: ConsoleAuthorizeContext[] = []
    install((context) => {
      seen.push(context)
      return true
    })
    await expect(callAsMcp("test.whoami", {})).resolves.toMatchObject({ ok: true, value: { surface: "mcp", user: { id: "user-1" } } })
    expect(seen[0]).toMatchObject({ surface: "mcp", via: "console" })
  })

  it("refuses an operation with mcp: false, and project.get does not list it", async () => {
    stubKeys(link.env)
    install()
    const refused = await callAsMcp("test.hidden", {})
    expect(refused).toMatchObject({ error: { code: "CONSOLE_ACCESS_DENIED", message: expect.stringContaining("test.hidden is not open to MCP clients"), status: 403 }, ok: false })
    const project = await callAsMcp("project.get", {})
    expect(project.ok && Reflect.get(Object(project.value), "operations")).toEqual(expect.arrayContaining(["test.whoami", "test.drop"]))
    expect(project.ok && Reflect.get(Object(project.value), "operations")).not.toContain("test.hidden")
    // The Console page still runs it.
    await expect(callAsMcp("test.hidden", {}, person)).resolves.toMatchObject({ ok: true, value: "ran" })
  })

  it("refuses a destructive call until the signed caller says that the person confirmed it", async () => {
    stubKeys(link.env)
    install()
    await expect(callAsMcp("test.drop", { key: "a" })).resolves.toMatchObject({ error: { code: "INTERNAL_R0026", status: 409 }, ok: false })
    await expect(callAsMcp("test.drop", { key: "a" }, mcpCaller(true))).resolves.toMatchObject({ ok: true, value: { dropped: "a" } })
  })

  it("does not take the confirmation from an unsigned header or a changed caller", async () => {
    stubKeys(link.env)
    install()
    const signed = await signedRpcRequest({ caller: mcpCaller(), input: { key: "a" }, key: link.key, operation: "test.drop" })
    const headers = new Headers(signed.headers)
    headers.set("x-vitehub-confirmation", "confirmed")
    const response = await send(new Request(signed.url, { body: await signed.text(), headers, method: "POST" }))
    expect(response.status).toBe(409)
    headers.set(consoleCallerHeader, Buffer.from(JSON.stringify(mcpCaller(true))).toString("base64url"))
    const forged = await send(new Request(signed.url, { body: operationRpcBody("test.drop", { key: "a" }), headers, method: "POST" }))
    expect(forged.status).toBe(401)
  })

  it("sends a call larger than 64 KiB through birpc and the signed forwarder", async () => {
    stubKeys(link.env)
    install()
    const text = "x".repeat(512 * 1024)
    await expect(callAsMcp("test.store", { text })).resolves.toMatchObject({ ok: true, value: { bytes: text.length } })
  })
})
