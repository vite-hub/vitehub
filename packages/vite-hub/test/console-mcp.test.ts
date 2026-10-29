import { defineHandler } from "h3"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { createApp, eventHandler, toNodeListener } from "h3-v1"
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose"
import * as v from "valibot"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineOperation } from "@vite-hub/internal/operations"
import { registerViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"

import { consoleMcpCommands } from "../src/console/runtime/client/mcp.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { consoleRealtimeAccess, installConsoleAccess } from "../src/console/runtime/server/access.ts"
import type { ConsoleAuthorize } from "../src/console/auth.ts"
import type { ConsoleOAuthConfig } from "../src/console/runtime/server/bearer.ts"
import consoleMcpAuthorizationServerHandler from "../src/console/runtime/server/mcp-authorization-server.ts"
import consoleMcpDiscoveryHandler from "../src/console/runtime/server/mcp-discovery.ts"
import consoleMcpHandler from "../src/console/runtime/server/mcp.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import consoleMcpMetadataHandler from "../src/console/runtime/server/mcp-metadata.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"
import { resolveConsoleAccessBuild, type ConsoleOptions } from "../src/console/vite.ts"

const greet = defineOperation({
  description: "Greet someone.",
  input: v.strictObject({ name: v.string() }),
  kind: "read",
  name: "fixture.greet",
  run: ({ name }, { surface, user }) => ({ greeting: `Hello ${name}`, surface, user: user?.id ?? null }),
  section: "fixture",
})
const save = defineOperation({
  description: "Save a note.",
  input: v.strictObject({ text: v.string() }),
  kind: "write",
  name: "fixture.save",
  run: ({ text }) => ({ saved: text }),
  section: "fixture",
})
const remove = defineOperation({
  description: "Remove a note.",
  input: v.strictObject({ id: v.string() }),
  kind: "destructive",
  name: "fixture.remove",
  run: ({ id }) => {
    if (id === "locked") throw Object.assign(new Error("The note is locked."), { code: "FIXTURE_R0001", fix: "Unlock it first.", status: 409 })
    if (id === "boom") throw Object.assign(new Error("Storage is down."), { code: "FIXTURE_R0002", details: { secret: 1 }, status: 500 })
    return { id }
  },
  section: "fixture",
})
const other = defineOperation({ ...greet, name: "other.greet", section: "other" })
const editorOnly = defineOperation({ ...greet, mcp: false, name: "fixture.editor" })

// The route tests run as a development server does. Access tests install their own policy.
installConsoleAccess({ mode: "open" })

const origin = "http://vitehub.local"

async function read<T>(response: Response): Promise<T> {
  const body: unknown = await response.json()
  // SAFETY: Each test names the JSON-RPC answer shape that it expects.
  return body as T
}

function post(message: unknown, headers: Record<string, string> = {}, url = `${origin}/_vitehub/mcp`) {
  return defineHandler(consoleMcpHandler).fetch(new Request(url, {
    body: JSON.stringify(message),
    headers: { "accept": "application/json, text/event-stream", "content-type": "application/json", ...headers },
    method: "POST",
  }))
}

const rpc = (id: number, method: string, params?: unknown) => ({ id, jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })

async function call(name: string, args: unknown, headers: Record<string, string> = {}) {
  const response = await post(rpc(1, "tools/call", { arguments: args, name }), headers)
  expect(response.status).toBe(200)
  return await response.json() as { error?: { code: number, message: string }, result?: { content: Array<{ text: string }>, isError: boolean, structuredContent?: Record<string, unknown> } }
}

afterEach(() => {
  installConsoleDevelopment("/tmp/console-mcp", false)
  vi.unstubAllEnvs()
  installConsoleAccess({ mode: "open" })
  installConsoleOperations([])
  registerViteHubMcpTools("comments", [])
})

function install() {
  installConsoleOperations([{ operations: [greet, save, remove, other, editorOnly], plugin: "fixture-plugin" }])
}

describe("MCP endpoint", () => {
  it("reads tool calls through the h3 1 HTTP server used by Nuxt 4", async () => {
    install()
    installConsoleDevelopment("/tmp/console-mcp", true)
    const app = createApp()
    app.use("/_vitehub/mcp", eventHandler(event => Reflect.apply(consoleMcpHandler, undefined, [event])))
    const server = createServer(toNodeListener(app))
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("The MCP test server has no TCP address.")
      const response = await fetch(`http://127.0.0.1:${address.port}/_vitehub/mcp`, {
        body: JSON.stringify(rpc(1, "tools/call", { arguments: { name: "Ada" }, name: "fixture_greet" })),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        id: 1,
        jsonrpc: "2.0",
        result: { isError: false, structuredContent: { greeting: "Hello Ada", surface: "mcp" } },
      })
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it("answers initialize with the tools capability, and takes notifications without an answer", async () => {
    install()
    const init = await read<{ result: Record<string, unknown> }>(await post(rpc(1, "initialize", { capabilities: {}, clientInfo: { name: "test", version: "1" }, protocolVersion: "2025-06-18" })))
    expect(init.result).toMatchObject({ capabilities: { tools: {} }, protocolVersion: "2025-06-18", serverInfo: { name: "vitehub", title: "ViteHub MCP" } })
    const future = await read<{ result: { protocolVersion: string } }>(await post(rpc(2, "initialize", { protocolVersion: "2099-01-01" })))
    expect(future.result.protocolVersion).toBe("2025-11-25")
    const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" })
    expect(note.status).toBe(202)
    expect(await note.text()).toBe("")
    expect(await (await post(rpc(3, "ping"))).json()).toEqual({ id: 3, jsonrpc: "2.0", result: {} })
  })

  it("lists a tool for each operation of the sections that console.authorize allows", async () => {
    install()
    installConsoleAccess({ authorize: () => ({ sections: ["fixture"] }), mode: "open" })
    const listed = await read<{ result: { tools: Array<{ annotations: Record<string, unknown>, description: string, inputSchema: Record<string, unknown>, name: string }> } }>(await post(rpc(1, "tools/list")))
    const tools = listed.result.tools.filter(tool => tool.name.startsWith("fixture_") || tool.name.startsWith("other_"))
    // A dot is not allowed in the tool names of some clients, so every other character becomes an underscore.
    expect(tools.map(tool => tool.name)).toEqual(["fixture_greet", "fixture_remove", "fixture_save"])
    expect(listed.result.tools.every(tool => /^[\w-]+$/.test(tool.name))).toBe(true)
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
    expect(byName["fixture_greet"]!.annotations).toMatchObject({ destructiveHint: false, readOnlyHint: true })
    expect(byName["fixture_save"]!.annotations).toMatchObject({ destructiveHint: false, readOnlyHint: false })
    expect(byName["fixture_remove"]!.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false })
    // The title is the name in words. The description keeps the sentence.
    expect(byName["fixture_greet"]).toMatchObject({ description: "Greet someone.", inputSchema: { properties: { name: { type: "string" } }, required: ["name"], type: "object" }, title: "Fixture greet" })
    // The built-in operations of other sections are gone too, and editor transports are never tools.
    expect(listed.result.tools.map(tool => tool.name)).not.toContain("agents_list")
    expect(listed.result.tools.map(tool => tool.name)).not.toContain("documents_action")
    installConsoleAccess({ authorize: () => ({ sections: ["other"] }), mode: "open" })
    const second = await read<{ result: { tools: Array<{ name: string }> } }>(await post(rpc(2, "tools/list")))
    // Operations for any Console user stay, such as the section list.
    expect(second.result.tools.map(tool => tool.name)).toEqual(["definitions_list", "other_greet", "sections_list"])
  })

  it("limits read-only section grants to read tools", async () => {
    install()
    installConsoleAccess({ authorize: () => ({ sections: ["fixture:read"] }), mode: "open" })
    const listed = await read<{ result: { tools: Array<{ name: string }> } }>(await post(rpc(1, "tools/list")))
    expect(listed.result.tools.filter(tool => tool.name.startsWith("fixture_")).map(tool => tool.name)).toEqual(["fixture_greet"])
    expect((await call("fixture_greet", { name: "Ada" })).result).toMatchObject({ isError: false })
    expect((await call("fixture_save", {})).error).toMatchObject({ code: -32602 })
    expect((await call("fixture_remove", { id: "note" })).error).toMatchObject({ code: -32602 })

    const run = vi.fn(({ text }: { text: string }) => ({ saved: text }))
    installConsoleOperations([{ operations: [
      defineOperation({ ...save, name: "fixture.dynamic", section: () => "fixture", run }),
      defineOperation({ ...save, name: "fixture.conditional", readOnlyWhen: ({ text }) => text === "", run }),
    ], plugin: "fixture-plugin" }])
    expect((await call("fixture_dynamic", { text: "change" })).result).toMatchObject({ isError: true })
    expect((await call("fixture_conditional", { text: "change" })).result).toMatchObject({ isError: true })
    expect(run).not.toHaveBeenCalled()
    expect((await call("fixture_conditional", { text: "" })).result).toMatchObject({ isError: false })
    expect(run).toHaveBeenCalledOnce()
  })

  it("uses the local developer for operations without sign-in only in development", async () => {
    install()
    const user = async () => {
      const response = await post(rpc(1, "tools/call", { arguments: { name: "Ada" }, name: "fixture_greet" }), {}, "http://localhost:5173/_vitehub/mcp")
      expect(response.status).toBe(200)
      const answer = await read<{ result: { structuredContent: { user: string | null } } }>(response)
      return answer.result.structuredContent.user
    }
    installConsoleDevelopment("/tmp/console-mcp", true)
    for (const mode of ["local", "open"] as const) {
      installConsoleAccess({ mode })
      expect(await user()).toBe("local")
    }
    installConsoleDevelopment("/tmp/console-mcp", false)
    vi.stubEnv("NODE_ENV", "development")
    installConsoleAccess({ mode: "open" })
    expect(await user()).toBeNull()
  })

  it("runs an operation as the signed-in user, with the mcp surface, by its tool name", async () => {
    install()
    installConsoleAccess({ check: async () => undefined, mode: "auth", user: async () => ({ email: "ada@example.com", id: "ada" }) })
    // The tool name is the only name. The operation name is not a tool.
    expect((await call("fixture.greet", { name: "Ada" })).error).toMatchObject({ code: -32602 })
    const answer = await call("fixture_greet", { name: "Ada" })
    expect(answer.result).toMatchObject({ isError: false, structuredContent: { greeting: "Hello Ada", surface: "mcp", user: "ada" } })
    expect(JSON.parse(answer.result!.content[0]!.text)).toEqual({ greeting: "Hello Ada", surface: "mcp", user: "ada" })
  })

  it("reports a failure as isError with code, message, and fix", async () => {
    install()
    const locked = await call("fixture_remove", { id: "locked" })
    expect(locked.result).toMatchObject({ isError: true, structuredContent: { error: { code: "FIXTURE_R0001", fix: "Unlock it first.", message: "The note is locked." } } })
    expect(locked.result!.content[0]!.text).toBe("FIXTURE_R0001: The note is locked.\nFix: Unlock it first.")
    const invalid = await call("fixture_remove", { id: 1 })
    expect(invalid.result).toMatchObject({ isError: true, structuredContent: { error: { code: "INTERNAL_R0022" } } })
    // A server failure does not leak its details.
    const boom = await call("fixture_remove", { id: "boom" })
    expect(boom.result).toMatchObject({ isError: true })
    expect(JSON.stringify(boom.result)).not.toContain("secret")
  })

  it("rejects a tool the caller may not see as an unknown tool", async () => {
    install()
    installConsoleAccess({ authorize: () => ({ sections: ["fixture"] }), mode: "open" })
    const denied = await call("other_greet", { name: "Ada" })
    expect(denied.error).toMatchObject({ code: -32602, message: expect.stringContaining("Unknown tool: other_greet.") })
    expect((await call("other.greet", { name: "Ada" })).error).toMatchObject({ code: -32602 })
    expect((await call("fixture_editor", { name: "Ada" })).error).toMatchObject({ code: -32602 })
    const unknown = await read<{ error: { code: number } }>(await post(rpc(5, "resources/list")))
    expect(unknown.error.code).toBe(-32601)
  })

  it("answers an unauthenticated request with 401, and a denied person with 403", async () => {
    install()
    for (const rejected of [
      new Response("{}", { status: 401 }),
      new Response(null, { headers: { location: "/_vitehub/sign-in" }, status: 302 }),
    ]) {
      // Without OAuth there is no resource metadata to point to.
      installConsoleAccess({ check: async () => rejected.clone(), mode: "auth" })
      const response = await post(rpc(1, "tools/list"))
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).not.toContain("resource_metadata")
      await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_SIGN_IN_REQUIRED" })
    }
    // Cloudflare Access has no OAuth flow either.
    installConsoleAccess({ check: async () => new Response("{}", { status: 401 }), mode: "cloudflare-access" })
    const access = await post(rpc(1, "tools/list"))
    expect(access.status).toBe(401)
    expect(access.headers.get("www-authenticate")).not.toContain("resource_metadata")
    // An access policy that denies the person stays a 403.
    installConsoleAccess({ authorize: () => false, mode: "open" })
    expect((await post(rpc(1, "tools/list"))).status).toBe(403)
  })

  it("serves only this machine in a development server without sign-in", async () => {
    installConsoleDevelopment("/tmp/console-mcp", true)
    install()
    vi.stubEnv("NODE_ENV", "development")
    for (const mode of ["local", "open"] as const) {
      installConsoleAccess({ mode })
      expect((await post(rpc(1, "tools/list"), {}, "http://localhost:5173/_vitehub/mcp")).status).toBe(200)
      const lan = await post(rpc(1, "tools/list"), {}, "http://192.168.1.20:5173/_vitehub/mcp")
      expect(lan.status).toBe(403)
      await expect(lan.json()).resolves.toMatchObject({ code: "CONSOLE_LOOPBACK_ONLY", fix: expect.stringContaining("console.auth") })
    }
    installConsoleAccess({ mode: "open" })
    vi.stubEnv("NODE_ENV", "production")
    expect((await post(rpc(1, "tools/list"), {}, "http://192.168.1.20:5173/_vitehub/mcp")).status).toBe(403)
  })

  it("refuses other methods and web pages of another origin", async () => {
    install()
    const get = await defineHandler(consoleMcpHandler).fetch(new Request(`${origin}/_vitehub/mcp`, { headers: { accept: "text/event-stream" } }))
    expect(get.status).toBe(405)
    expect(get.headers.get("allow")).toBe("POST")
    expect((await post(rpc(1, "ping"), { origin: "https://evil.example" })).status).toBe(403)
    expect((await post(rpc(1, "ping"), { origin })).status).toBe(200)
    const bad = await defineHandler(consoleMcpHandler).fetch(new Request(`${origin}/_vitehub/mcp`, { body: "{", method: "POST" }))
    expect(bad.status).toBe(400)
    await expect(bad.json()).resolves.toMatchObject({ error: { code: -32700 } })
  })
})

describe("MCP protocol limits", () => {
  const raw = (body: string, headers: Record<string, string> = {}) => defineHandler(consoleMcpHandler).fetch(new Request(`${origin}/_vitehub/mcp`, { body, headers: { "content-type": "application/json", ...headers }, method: "POST" }))

  it("honors operation limits for single calls", async () => {
    const run = vi.fn(({ text }: { text: string }) => ({ bytes: new TextEncoder().encode(text).byteLength }))
    const attachment = defineOperation({ description: save.description, input: save.input, kind: "write", maxRequestBytes: 3 * 1_024 * 1_024, name: "fixture.attachment", run, section: "fixture" })
    installConsoleOperations([{ operations: [save, attachment], plugin: "fixture-plugin" }])
    const call = (name: string, text: string) => rpc(1, "tools/call", { arguments: { text }, name })
    const oversized = call("fixture_save", "€".repeat(22_000))
    expect((await post(oversized)).status).toBe(413)
    expect(run).not.toHaveBeenCalled()
    const response = await post(call("fixture_attachment", "€".repeat(750_000)))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ result: { isError: false, structuredContent: { bytes: 2_250_000 } } })
    expect(run).toHaveBeenCalledTimes(1)
    expect((await post(call("fixture_attachment", "€".repeat(1_100_000)))).status).toBe(413)
    expect(run).toHaveBeenCalledTimes(1)
    // Whitespace in a single envelope still counts toward the operation's limit.
    expect((await raw(`${JSON.stringify(call("fixture_save", "ok"))}${" ".repeat(64 * 1_024)}`)).status).toBe(413)
    expect((await post(call("fixture_save", "ok"))).status).toBe(200)
  })

  it("counts the body in bytes, not characters", async () => {
    install()
    // 700,000 characters are 2.1 MB of UTF-8: under the limit as a string length, over it as bytes.
    const body = JSON.stringify(rpc(1, "ping", { text: "€".repeat(700_000) }))
    expect(body.length).toBeLessThan(2 * 1_024 * 1_024)
    const large = await raw(body)
    expect(large.status).toBe(413)
    await expect(large.json()).resolves.toMatchObject({ error: { code: -32600 } })
    expect((await raw(JSON.stringify(rpc(1, "ping", { text: "€".repeat(1_000) })))).status).toBe(200)
    // A lying content-length does not skip the count.
    expect((await raw(body, { "content-length": "10" })).status).toBe(413)
  })

  it("refuses a batch, which the supported revisions removed", async () => {
    install()
    const batch = await raw(JSON.stringify([rpc(1, "ping"), rpc(2, "ping")]))
    expect(batch.status).toBe(400)
    await expect(batch.json()).resolves.toMatchObject({ error: { code: -32600 }, id: null })
  })

  it("answers a message that is not a request with -32600", async () => {
    install()
    const answer = async (message: unknown) => await (await raw(JSON.stringify(message))).json()
    // An id without a method.
    expect(await answer({ id: 7, jsonrpc: "2.0" })).toMatchObject({ error: { code: -32600 }, id: 7 })
    expect(await answer({ id: 7, jsonrpc: "2.0", method: 5 })).toMatchObject({ error: { code: -32600 }, id: 7 })
    // An id that is not a string or a number has no usable id to answer to.
    for (const id of [null, true, { a: 1 }, [1]]) {
      expect(await answer({ id, jsonrpc: "2.0", method: "ping" }), JSON.stringify(id)).toMatchObject({ error: { code: -32600 }, id: null })
    }
    expect(await answer({ id: "a", jsonrpc: "2.0", method: "ping" })).toEqual({ id: "a", jsonrpc: "2.0", result: {} })
    expect(await answer({ id: 0, jsonrpc: "2.0", method: "ping" })).toEqual({ id: 0, jsonrpc: "2.0", result: {} })
    expect(await answer({ jsonrpc: "2.0" })).toMatchObject({ error: { code: -32600 }, id: null })
  })

  it("refuses a protocol version that it does not speak", async () => {
    install()
    const unsupported = await post(rpc(1, "ping"), { "mcp-protocol-version": "1999-01-01" })
    expect(unsupported.status).toBe(400)
    await expect(unsupported.json()).resolves.toMatchObject({ error: { code: -32600, message: expect.stringContaining("1999-01-01") } })
    expect((await post(rpc(1, "ping"), { "mcp-protocol-version": "2025-06-18" })).status).toBe(200)
    expect((await post(rpc(1, "ping"))).status).toBe(200)
  })
})

describe("MCP sign-in with OAuth access tokens", () => {
  const app = "https://app.example.com"
  const resource = `${app}/_vitehub/mcp`
  const bothScopes = "vitehub:read vitehub:write"

  /** A stand-in for the Better Auth instance of the app: its keys and users are in-process, its baseURL follows the request. */
  async function authorizationServer(settings: { baseURL?: string, plugins?: Record<string, unknown>, resource?: string } = {}) {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true })
    const jwk = { ...await exportJWK(publicKey), alg: "RS256", kid: "key-1", use: "sig" }
    const users: Record<string, Record<string, unknown>> = {
      ada: { email: "ada@example.com", id: "ada", name: "Ada" },
      bob: { banned: true, email: "bob@example.com", id: "bob" },
      eve: { banExpires: new Date(Date.now() - 1_000), banned: true, email: "eve@example.com", id: "eve" },
    }
    const wanted = settings.resource ?? resource
    const plugins = settings.plugins ?? {
      "jwt": {},
      "oauth-provider": { clientRegistrationDefaultResources: [wanted], resources: [wanted], scopes: ["openid", "vitehub:read", "vitehub:write"] },
    }
    const built: string[] = []
    const auth = (request: Request) => {
      built.push(request.url)
      const baseURL = settings.baseURL ?? `${new URL(request.url).origin}/api/auth`
      return {
        $context: Promise.resolve({
          baseURL,
          getPlugin: (id: string) => id in plugins ? { options: plugins[id] } : null,
          internalAdapter: { findUserById: async (id: string) => users[id] ?? null },
        }),
        api: {
          getJwks: async () => ({ keys: [jwk] }),
          getOAuthServerConfig: async () => ({ issuer: baseURL, token_endpoint: `${baseURL}/oauth2/token` }),
        },
      }
    }
    const token = (claims: { audience?: string, expires?: number | string, issuer?: string, key?: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"], scope?: string, subject?: string } = {}) => new SignJWT({ scope: claims.scope ?? bothScopes })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setAudience(claims.audience ?? resource)
      .setIssuer(claims.issuer ?? `${app}/api/auth`)
      .setSubject(claims.subject ?? "ada")
      .setExpirationTime(claims.expires ?? "5m")
      .sign(claims.key ?? privateKey)
    return { auth, built, jwk, privateKey, token }
  }

  function installOAuth(auth: ConsoleOAuthConfig["auth"], config: { issuer?: string, path?: string, resource?: string } = { resource }, authorize?: ConsoleAuthorize) {
    installConsoleAccess({ authorize, check: async () => new Response("{}", { status: 401 }), mode: "auth", oauth: { auth, path: "/_vitehub/mcp", ...config } })
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  it("delegates other resources' OAuth discovery to the application", async () => {
    const issuer = await authorizationServer()
    installOAuth(issuer.auth)
    const application = vi.fn(() => Response.json({ owner: "application" }))
    const handler = defineHandler(async event => await consoleMcpDiscoveryHandler(event) ?? application())
    for (const prefix of ["oauth-protected-resource", "oauth-authorization-server"]) {
      const response = await handler.fetch(new Request(`${app}/.well-known/${prefix}/other`))
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ owner: "application" })
    }
    expect(application).toHaveBeenCalledTimes(2)
    for (const suffix of ["oauth-protected-resource", "oauth-protected-resource/_vitehub/mcp", "oauth-authorization-server", "oauth-authorization-server/api/auth"]) {
      expect((await handler.fetch(new Request(`${app}/.well-known/${suffix}`))).status).toBe(200)
    }
    expect(application).toHaveBeenCalledTimes(2)
    const incomplete = await authorizationServer({ plugins: {} })
    installOAuth(incomplete.auth)
    expect((await handler.fetch(new Request(`${app}/.well-known/oauth-protected-resource`))).status).toBe(503)
    expect(application).toHaveBeenCalledTimes(2)
  })

  it("accepts a bearer token that the app issued for the endpoint, as the person in its sub claim", async () => {
    install()
    const issuer = await authorizationServer()
    installOAuth(issuer.auth, { resource }, ({ user }) => user?.id === "ada" && user.email === "ada@example.com" ? { sections: ["fixture"] } : false)
    const headers = bearer(await issuer.token())
    const answer = await read<{ result: { structuredContent: Record<string, unknown> } }>(await post(rpc(1, "tools/call", { arguments: { name: "Ada" }, name: "fixture_greet" }), headers, resource))
    expect(answer.result.structuredContent).toEqual({ greeting: "Hello Ada", surface: "mcp", user: "ada" })
    // console.authorize ran for that user, so another person gets nothing.
    expect((await post(rpc(1, "tools/list"), bearer(await issuer.token({ subject: "ada2" })), resource)).status).toBe(401)
  })

  it("never takes the issuer, resource, or keys from the Host of the request", async () => {
    install()
    const issuer = await authorizationServer()
    installOAuth(issuer.auth)
    // An attacker serves a key set of their own and names themselves as issuer and audience, with a Host that matches.
    const attacker = await generateKeyPair("RS256")
    const forged = await new SignJWT({ scope: bothScopes })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setAudience("https://evil.example/_vitehub/mcp")
      .setIssuer("https://evil.example/api/auth")
      .setSubject("ada")
      .setExpirationTime("5m")
      .sign(attacker.privateKey)
    const forgedResponse = await post(rpc(1, "tools/list"), bearer(forged), "https://evil.example/_vitehub/mcp")
    expect(forgedResponse.status).toBe(401)
    expect(forgedResponse.headers.get("www-authenticate")).toContain('error="invalid_token"')
    // A token that the app signed for the evil audience is no better: the audience is the configured resource.
    const wrongAudience = await issuer.token({ audience: "https://evil.example/_vitehub/mcp", issuer: "https://evil.example/api/auth" })
    expect((await post(rpc(1, "tools/list"), bearer(wrongAudience), "https://evil.example/_vitehub/mcp")).status).toBe(401)
    // The Auth was built for the configured origin, whatever the Host said.
    expect(new Set(issuer.built)).toEqual(new Set([`${app}/_vitehub/mcp`]))
    // A real token still works through a proxy that rewrites the Host.
    expect((await post(rpc(1, "tools/list"), bearer(await issuer.token()), "https://internal.local/_vitehub/mcp")).status).toBe(200)
  })

  it.each(["https://login.example.com", "https://login.example.com/", "https://login.example.com/api/auth/", "https://login.example.com/api/auth//"])("normalizes the configured issuer %s while preserving the resource identifier", async (identifier) => {
    install()
    const audience = `${resource}/`
    const normalized = new URL(identifier).toString().replace(/\/$/, "")
    const issuer = await authorizationServer({ resource: audience })
    const configured = resolveConsoleAccessBuild({ auth: {}, mcp: { issuer: identifier, resource: audience } }, { handlers: { auth: true, middleware: "/tmp/middleware.mjs" }, root: "/tmp" }).oauth
    if (!configured) throw new Error("Expected OAuth configuration.")
    installOAuth(issuer.auth, configured)
    expect((await post(rpc(1, "tools/list"), bearer(await issuer.token({ audience, issuer: normalized })), resource)).status).toBe(200)
    expect((await post(rpc(1, "tools/list"), bearer(await issuer.token({ audience, issuer: `${normalized}/` })), resource)).status).toBe(401)
    expect((await post(rpc(1, "tools/list"), bearer(await issuer.token({ audience: resource, issuer: normalized })), resource)).status).toBe(401)
    const metadata = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))
    await expect(metadata.json()).resolves.toMatchObject({ authorization_servers: [normalized], resource: audience })
  })

  it("rejects tokens for another issuer or resource, expired ones beyond the tolerance, and an algorithm that the keys do not use", async () => {
    install()
    const issuer = await authorizationServer()
    installOAuth(issuer.auth)
    const now = Math.floor(Date.now() / 1000)
    const status = async (token: string) => (await post(rpc(1, "tools/list"), bearer(token), resource)).status
    expect(await status(await issuer.token())).toBe(200)
    expect(await status(await issuer.token({ audience: "https://other.example/_vitehub/mcp" }))).toBe(401)
    expect(await status(await issuer.token({ issuer: "https://evil.example/api/auth" }))).toBe(401)
    expect(await status(await issuer.token({ expires: now - 20 }))).toBe(200)
    expect(await status(await issuer.token({ expires: now - 120 }))).toBe(401)
    expect(await status("not-a-token")).toBe(401)
    // The key set says RS256. A token signed with PS256 by the same key is refused.
    const pss = await importJWK(await exportJWK(issuer.privateKey), "PS256")
    const confused = await new SignJWT({ scope: bothScopes }).setProtectedHeader({ alg: "PS256", kid: "key-1" }).setAudience(resource).setIssuer(`${app}/api/auth`).setSubject("ada").setExpirationTime("5m").sign(pss)
    expect(await status(confused)).toBe(401)
    // The configured issuer wins over the Auth.
    installOAuth(issuer.auth, { issuer: "https://login.example.com", resource })
    expect(await status(await issuer.token())).toBe(401)
    expect(await status(await issuer.token({ issuer: "https://login.example.com" }))).toBe(200)
  })

  it("loses access when the person is deleted or banned, with the token still valid", async () => {
    install()
    const issuer = await authorizationServer()
    installOAuth(issuer.auth)
    for (const subject of ["ghost", "bob"]) {
      const response = await post(rpc(1, "tools/list"), bearer(await issuer.token({ subject })), resource)
      expect(response.status, subject).toBe(401)
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"')
    }
    // A ban that has run out no longer counts.
    expect((await post(rpc(1, "tools/list"), bearer(await issuer.token({ subject: "eve" })), resource)).status).toBe(200)
  })

  it("limits the tools by the scopes of the token", async () => {
    install()
    const issuer = await authorizationServer()
    installOAuth(issuer.auth)
    const names = async (scope: string) => (await read<{ result: { tools: Array<{ name: string }> } }>(await post(rpc(1, "tools/list"), bearer(await issuer.token({ scope })), resource))).result.tools.map(tool => tool.name).filter(name => name.startsWith("fixture_"))
    expect(await names("vitehub:read")).toEqual(["fixture_greet"])
    expect(await names("vitehub:write")).toEqual(["fixture_remove", "fixture_save"])
    expect(await names(bothScopes)).toEqual(["fixture_greet", "fixture_remove", "fixture_save"])
    expect(await names("openid")).toEqual([])
    const readOnly = bearer(await issuer.token({ scope: "vitehub:read" }))
    expect((await post(rpc(1, "tools/call", { arguments: { name: "Ada" }, name: "fixture_greet" }), readOnly, resource)).status).toBe(200)
    for (const name of ["fixture_save", "fixture_remove"]) {
      const denied = await post(rpc(2, "tools/call", { arguments: { id: "x", text: "x" }, name }), readOnly, resource)
      expect(denied.status).toBe(403)
      expect(denied.headers.get("www-authenticate")).toBe(`Bearer error="insufficient_scope", error_description="The access token lacks a scope that this tool needs.", scope="vitehub:write", resource_metadata="${app}/.well-known/oauth-protected-resource/_vitehub/mcp"`)
      await expect(denied.json()).resolves.toMatchObject({ error: { code: -32001, message: expect.stringContaining("vitehub:write") }, id: 2 })
    }
    // A signed-in session has no scope limit.
    installConsoleAccess({ check: async () => undefined, mode: "auth", user: async () => ({ id: "ada" }) })
    expect((await call("fixture_save", { text: "x" })).result).toMatchObject({ isError: false })
  })

  it("applies OAuth scopes to contributed tools and passes their bearer user and event", async () => {
    const issuer = await authorizationServer()
    installOAuth(issuer.auth, { resource }, () => ({ sections: ["comments"] }))
    installConsoleSections("/tmp/console-mcp", ["comments"])
    // Generated Comments plugins use this adapter to check the same request's Console identity.
    const ownerAccess = consoleRealtimeAccess("comments")
    const called = vi.fn<ViteHubMcpTool["call"]>(async (_input, context) => {
      const user = await ownerAccess.user({ event: context.event })
      return { text: String(user?.id), structured: { event: Boolean(context.event), sameUser: user?.id === context.user?.id } }
    })
    registerViteHubMcpTools("comments", [true, false].map(readOnly => ({
      name: readOnly ? "comments_list_threads" : "comments_reply",
      description: "A contributed Comments tool.",
      section: "comments",
      annotations: { readOnlyHint: readOnly },
      inputSchema: { type: "object", properties: {} },
      call: called,
    })))
    const readOnly = bearer(await issuer.token({ scope: "vitehub:read" }))
    const listed = await read<{ result: { tools: Array<{ name: string }> } }>(await post(rpc(1, "tools/list"), readOnly, resource))
    expect(listed.result.tools.map(tool => tool.name).filter(name => name.startsWith("comments_"))).toEqual(["comments_list_threads"])
    const reply = rpc(2, "tools/call", { name: "comments_reply" })
    const denied = await post(reply, readOnly, resource)
    expect(denied.status).toBe(403)
    expect(denied.headers.get("www-authenticate")).toContain('scope="vitehub:write"')
    expect(called).not.toHaveBeenCalled()
    const allowed = await post(reply, bearer(await issuer.token()), resource)
    await expect(allowed.json()).resolves.toMatchObject({ result: { content: [{ text: "ada" }], structuredContent: { event: true, sameUser: true }, isError: false } })
    expect(called).toHaveBeenCalledTimes(1)
    installConsoleSections("/tmp/console-mcp", [])
    const hidden = await post(reply, bearer(await issuer.token()), resource)
    await expect(hidden.json()).resolves.toMatchObject({ error: { code: -32602 } })
    expect(called).toHaveBeenCalledTimes(1)
  })

  it("accepts a token on the mounted endpoint path only, and opens no other route", async () => {
    install()
    const issuer = await authorizationServer()
    installOAuth(issuer.auth)
    const headers = bearer(await issuer.token())
    expect((await post(rpc(1, "ping"), headers, `${app}/_vitehub/mcp`)).status).toBe(200)
    // The path must be the endpoint, not contain it.
    for (const path of ["/_vitehub/mcp/", "/other/_vitehub/mcp", "/_vitehub/mcp/extra", "/portal/_vitehub/mcp"]) {
      expect((await post(rpc(1, "ping"), headers, `${app}${path}`)).status, path).toBe(401)
    }
    const rpcResponse = await defineHandler(consoleRpcHandler).fetch(new Request(`${app}/_vitehub/rpc/_vitehub/mcp`, {
      body: JSON.stringify({ input: {}, operation: "sections.list" }),
      headers: { ...headers, "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }))
    expect(rpcResponse.status).toBe(401)
    const rpcRoot = await defineHandler(consoleRpcHandler).fetch(new Request(`${app}/_vitehub/rpc/__call`, {
      body: JSON.stringify({ input: {}, operation: "sections.list" }),
      headers: { ...headers, "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }))
    expect(rpcRoot.status).toBe(401)
    // An app below a base path serves the endpoint there.
    const portal = await authorizationServer({ resource: `${app}/portal/_vitehub/mcp` })
    installOAuth(portal.auth, { path: "/portal/_vitehub/mcp", resource: `${app}/portal/_vitehub/mcp` })
    const mounted = bearer(await portal.token({ audience: `${app}/portal/_vitehub/mcp` }))
    expect((await post(rpc(1, "ping"), mounted, `${app}/portal/_vitehub/mcp`)).status).toBe(200)
    expect((await post(rpc(1, "ping"), mounted, `${app}/_vitehub/mcp`)).status).toBe(401)
  })

  it("points a client without a token at the resource metadata, and a bad token at invalid_token", async () => {
    install()
    const issuer = await authorizationServer()
    installOAuth(issuer.auth)
    const missing = await post(rpc(1, "tools/list"), {}, resource)
    expect(missing.status).toBe(401)
    expect(missing.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${app}/.well-known/oauth-protected-resource/_vitehub/mcp"`)
    const bad = await post(rpc(1, "tools/list"), bearer("nope"), resource)
    expect(bad.status).toBe(401)
    expect(bad.headers.get("www-authenticate")).toBe(`Bearer error="invalid_token", error_description="The access token is not valid.", resource_metadata="${app}/.well-known/oauth-protected-resource/_vitehub/mcp"`)
    // A mounted app keeps its prefix in the metadata location.
    const portal = await authorizationServer({ resource: `${app}/portal/_vitehub/mcp` })
    installOAuth(portal.auth, { path: "/portal/_vitehub/mcp", resource: `${app}/portal/_vitehub/mcp` })
    expect((await post(rpc(1, "tools/list"), {}, `${app}/portal/_vitehub/mcp`)).headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/portal/_vitehub/mcp")
  })

  it("turns OAuth off in production without a configured origin, and says why", async () => {
    install()
    const issuer = await authorizationServer()
    // No resource, no publicUrl, and an Auth whose baseURL follows the request.
    installOAuth(issuer.auth, {})
    const token = await issuer.token()
    const response = await post(rpc(1, "tools/list"), bearer(token), resource)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).not.toContain("resource_metadata")
    const metadata = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`, { headers: { host: "evil.example" } }))
    expect(metadata.status).toBe(503)
    await expect(metadata.json()).resolves.toMatchObject({ code: "CONSOLE_MCP_ORIGIN_REQUIRED", fix: expect.stringContaining("console.mcp.resource") })
    // The development server has no fixed origin, so it uses the request, which only picks its own in-process keys.
    installConsoleDevelopment("/tmp/console-mcp", true)
    expect((await post(rpc(1, "tools/list"), bearer(token), resource)).status).toBe(200)
    installConsoleDevelopment("/tmp/console-mcp", false)
    // An Auth that declares its own baseURL names the origin.
    const declared = await authorizationServer({ baseURL: `${app}/api/auth` })
    installOAuth(declared.auth, {})
    expect((await post(rpc(1, "tools/list"), bearer(await declared.token()), "https://evil.example/_vitehub/mcp")).status).toBe(200)
  })

  it("answers 503 with the fix when the Auth cannot issue MCP tokens", async () => {
    install()
    const incomplete: Array<[string, Record<string, unknown>, string]> = [
      ["no plugins", {}, "the `jwt()` plugin, the `oauthProvider()` plugin"],
      ["no oauthProvider", { jwt: {} }, "the `oauthProvider()` plugin"],
      ["no resources", { "jwt": {}, "oauth-provider": { scopes: ["vitehub:read", "vitehub:write"] } }, "opaque tokens"],
      ["another resource", { "jwt": {}, "oauth-provider": { resources: ["https://other.example/_vitehub/mcp"], scopes: ["vitehub:read", "vitehub:write"] } }, "opaque tokens"],
      ["no default registration resource", { "jwt": {}, "oauth-provider": { resources: [resource], scopes: ["vitehub:read", "vitehub:write"] } }, "clientRegistrationDefaultResources"],
      ["no scopes", { "jwt": {}, "oauth-provider": { resources: [resource], scopes: ["openid"] } }, '"vitehub:read" and "vitehub:write"'],
    ]
    for (const [label, plugins, mentions] of incomplete) {
      const issuer = await authorizationServer({ plugins })
      installOAuth(issuer.auth)
      for (const handler of [consoleMcpMetadataHandler, consoleMcpAuthorizationServerHandler]) {
        const response = await defineHandler(handler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))
        expect(response.status, label).toBe(503)
        const body = await read<{ code: string, fix: string, message: string }>(response)
        expect(body.code).toBe("CONSOLE_MCP_OAUTH_INCOMPLETE")
        expect(body.message).toContain(mentions)
        expect(body.fix).toContain("jwt()")
        expect(body.fix).toContain("oauthProvider(")
        expect(body.fix).toContain('resources: ["<origin>/_vitehub/mcp"]')
        expect(body.fix).toContain('clientRegistrationDefaultResources: ["<origin>/_vitehub/mcp"]')
      }
      expect((await post(rpc(1, "tools/list"), bearer(await issuer.token()), resource)).status, label).toBe(401)
    }
  })

  it.each(["", "/portal"])("serves the advertised metadata URL for a trailing-slash resource mounted at '%s'", async (base) => {
    const path = `${base}/_vitehub/mcp`
    const audience = `${app}${path}/`
    const issuer = await authorizationServer({ resource: audience })
    installOAuth(issuer.auth, { path, resource: audience })
    const challenge = await post(rpc(1, "tools/list"), {}, `${app}${path}`)
    expect(challenge.status).toBe(401)
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate") ?? "")?.[1]
    expect(metadataUrl).toBe(`${app}/.well-known/oauth-protected-resource${path}/`)
    if (!metadataUrl) throw new Error("Expected an OAuth metadata URL.")
    const metadata = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(metadataUrl))
    expect(metadata.status).toBe(200)
    await expect(metadata.json()).resolves.toMatchObject({ resource: audience })
    expect((await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource/other/`))).status).toBe(404)
  })

  it("publishes the protected resource metadata from the configured resource", async () => {
    const issuer = await authorizationServer()
    installOAuth(issuer.auth)
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/_vitehub/mcp"]) {
      // The Host of the request does not change the answer.
      const response = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`https://evil.example${path}`))
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ authorization_servers: [`${app}/api/auth`], bearer_methods_supported: ["header"], resource, scopes_supported: expect.arrayContaining(["vitehub:read", "vitehub:write"]) })
    }
    expect((await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource/other`))).status).toBe(404)
    // The bare metadata of an app below a base path names the endpoint with the base.
    const portal = await authorizationServer({ resource: `${app}/portal/_vitehub/mcp` })
    installOAuth(portal.auth, { path: "/portal/_vitehub/mcp", resource: `${app}/portal/_vitehub/mcp` })
    const mounted = await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))
    await expect(mounted.json()).resolves.toMatchObject({ resource: `${app}/portal/_vitehub/mcp` })
    expect((await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource/portal/_vitehub/mcp`))).status).toBe(200)
    // No OAuth, no metadata.
    installConsoleAccess({ mode: "open" })
    expect((await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))).status).toBe(404)
    installConsoleAccess({ check: async () => new Response("{}", { status: 401 }), mode: "cloudflare-access" })
    expect((await defineHandler(consoleMcpMetadataHandler).fetch(new Request(`${app}/.well-known/oauth-protected-resource`))).status).toBe(404)
  })

  it("serves the authorization server metadata at the origin root, for the issuer path", async () => {
    const issuer = await authorizationServer()
    installOAuth(issuer.auth)
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/api/auth"]) {
      const response = await defineHandler(consoleMcpAuthorizationServerHandler).fetch(new Request(`${app}${path}`))
      expect(response.status, path).toBe(200)
      await expect(response.json()).resolves.toEqual({ issuer: `${app}/api/auth`, token_endpoint: `${app}/api/auth/oauth2/token` })
    }
    expect((await defineHandler(consoleMcpAuthorizationServerHandler).fetch(new Request(`${app}/.well-known/oauth-authorization-server/elsewhere`))).status).toBe(404)
    installConsoleAccess({ mode: "open" })
    expect((await defineHandler(consoleMcpAuthorizationServerHandler).fetch(new Request(`${app}/.well-known/oauth-authorization-server`))).status).toBe(404)
  })
})

describe("MCP setup", () => {
  it.each([true, "cloudflare-access"] as const)("quotes shell metacharacters in the Claude endpoint for auth %s", auth => {
    const endpoint = "https://app.example.com/';printf SHELL_INTERPRETED;$(printf expanded)&/_vitehub/mcp"
    const command = consoleMcpCommands(endpoint, auth)[0]!.text
    // Exercise shell argument parsing with a harmless stand-in for the Claude executable.
    const result = spawnSync("sh", ["-c", 'claude() { printf "<%s>\\n" "$@"; }\n' + command], { encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout.split("\n")[5]).toBe(`<${endpoint}>`)
    expect(result.stdout).not.toContain("<https://app.example.com/>")
  })

  it("shows the commands that connect Claude Code and Codex", () => {
    expect(consoleMcpCommands("https://app.example.com/_vitehub/mcp")).toEqual([
      { label: "Claude Code", text: "claude mcp add --transport http vitehub 'https://app.example.com/_vitehub/mcp'" },
      { label: "Codex", text: '[mcp_servers.vitehub]\nurl = "https://app.example.com/_vitehub/mcp"' },
    ])
  })

  it("includes both Cloudflare Access service-token headers without embedding credentials", () => {
    const [claude, codex] = consoleMcpCommands("https://app.example.com/portal/_vitehub/mcp", "cloudflare-access")
    expect(claude?.text).toBe('claude mcp add --transport http vitehub \'https://app.example.com/portal/_vitehub/mcp\' --header "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" --header "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"')
    expect(codex?.text).toBe('[mcp_servers.vitehub]\nurl = "https://app.example.com/portal/_vitehub/mcp"\nenv_http_headers = { "CF-Access-Client-Id" = "CF_ACCESS_CLIENT_ID", "CF-Access-Client-Secret" = "CF_ACCESS_CLIENT_SECRET" }')
    expect(consoleMcpCommands("http://localhost/_vitehub/mcp", false)).toEqual(consoleMcpCommands("http://localhost/_vitehub/mcp", true))
  })

  it("builds the OAuth settings from console.mcp and the base path, and refuses a relative URL", () => {
    // SAFETY: The test passes the Console Auth config shape that `resolveConsoleAccessBuild()` reads.
    const session = { auth: { provider: "github" } } as unknown as ConsoleOptions
    const handlers = { auth: true as const, middleware: "/tmp/middleware.mjs" }
    expect(resolveConsoleAccessBuild(session, { handlers, root: "/tmp" })).toMatchObject({ mode: "auth", oauth: { path: "/_vitehub/mcp" } })
    expect(resolveConsoleAccessBuild(session, { base: "/portal/", handlers, root: "/tmp" }).oauth).toEqual({ path: "/portal/_vitehub/mcp" })
    const configured = resolveConsoleAccessBuild({ ...session, mcp: { issuer: "https://login.example.com/api/auth/", resource: "https://app.example.com/_vitehub/mcp" } }, { handlers, root: "/tmp" })
    expect(configured.oauth).toEqual({ issuer: "https://login.example.com/api/auth", path: "/_vitehub/mcp", resource: "https://app.example.com/_vitehub/mcp" })
    expect(() => resolveConsoleAccessBuild({ ...session, mcp: { resource: "/_vitehub/mcp" } }, { handlers, root: "/tmp" })).toThrowError(/console\.mcp\.resource must be an absolute http\(s\) URL/)
    // Cloudflare Access and open Consoles take no access tokens.
    expect(resolveConsoleAccessBuild(session, { handlers: { auth: "cloudflare-access" as never, middleware: "/tmp/middleware.mjs" }, root: "/tmp" })).not.toHaveProperty("oauth")
    expect(resolveConsoleAccessBuild({ auth: false }, { root: "/tmp" })).not.toHaveProperty("oauth")
  })
})
