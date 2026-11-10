import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { defineAuth } from "@vite-hub/auth"
import { createAuthAccessHandler, createAuthForRequest } from "@vite-hub/auth/server"
import { installedOperationSectionResolver } from "@vite-hub/internal/operations"
import { defineHandler, H3 } from "h3"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { requestEvent } from "./console-event.ts"

import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import channelReplayHandler from "../src/console/runtime/server/channel-replay.ts"
import consolePreflightPlugin from "../src/console/runtime/server/console-preflight.ts"
import { consoleTokenMatchesHash } from "../src/console/runtime/server/console-token.ts"
import { answerConsolePreflight, installConsoleOrigins, withConsoleCors } from "../src/console/runtime/server/cors.ts"
import envManageHandler from "../src/console/runtime/server/env-manage.ts"
import { installConsoleEnv } from "../src/console/runtime/server/env.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"
import scheduleRunHandler from "../src/console/runtime/server/schedule-run.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { addConsoleRpcHandler } from "../src/console/nitro.ts"
import { resolveConsoleAccessBuild, resolveConsoleOptions, resolveConsoleOrigins } from "../src/console/vite.ts"

import type { ConsoleAuthorizeContext } from "../src/console/auth-types.ts"
import type { ConsoleAccessPolicy } from "../src/console/runtime/server/access.ts"

const app = "https://app.example.com"
const consoleOrigin = "https://console.vitehub.dev"
const token = "test-console-token-0123456789abcdef"
const tokenHash = createHash("sha256").update(token).digest("hex")
const ciToken = "test-ci-token-0123456789abcdef0123"
const ciTokenHash = createHash("sha256").update(ciToken).digest("hex")
const policyKey = Symbol.for("vitehub.console.access")
const originsKey = Symbol.for("vitehub.console.origins")

function install(policy: ConsoleAccessPolicy, origins: readonly string[] = [consoleOrigin]): void {
  installConsoleAccess(policy)
  installConsoleOrigins(origins)
}

function rpc(headers: Record<string, string>, init: { operation?: string, path?: string } = {}): Request {
  return new Request(`${app}${init.path ?? "/_vitehub/rpc/__call"}`, {
    body: JSON.stringify({ input: {}, operation: init.operation ?? "sections.list" }),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })
}

function send(request: Request): Promise<Response> {
  return defineHandler(consoleRpcHandler).fetch(request)
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, originsKey)
  Reflect.deleteProperty(globalThis, policyKey)
})

describe("console: { auth: \"token\" }", () => {
  it("accepts the token whose SHA-256 is in VITEHUB_CONSOLE_TOKEN_SHA256", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", tokenHash)
    install({ mode: "token" })
    const response = await send(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }))
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(response.headers.has("access-control-allow-origin")).toBe(false)
  })

  it("reads the token from the Cloudflare env of the request", async () => {
    install({ mode: "token" })
    const request = Object.assign(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }), {
      runtime: { name: "cloudflare", cloudflare: { context: { passThroughOnException: vi.fn(), waitUntil: vi.fn() }, env: { VITEHUB_CONSOLE_TOKEN_SHA256: tokenHash.toUpperCase() } } },
    })
    expect((await send(request)).status).toBe(200)
  })

  it("accepts the token of every VITEHUB_CONSOLE_TOKEN_SHA256_<NAME> variable, so removing one revokes only that caller", async () => {
    install({ mode: "token" })
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", undefined)
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256_CONSOLE_EXAMPLE_COM", tokenHash)
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256_CI", ` ${ciTokenHash.toUpperCase()} `)
    expect((await send(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }))).status).toBe(200)
    expect((await send(rpc({ authorization: `Bearer ${ciToken}`, [consoleRpcHeader]: "1" }))).status).toBe(200)
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256_CONSOLE_EXAMPLE_COM", undefined)
    const revoked = await send(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }))
    expect(revoked.status).toBe(401)
    await expect(revoked.json()).resolves.toMatchObject({ code: "CONSOLE_TOKEN_INVALID" })
    expect((await send(rpc({ authorization: `Bearer ${ciToken}`, [consoleRpcHeader]: "1" }))).status).toBe(200)
  })

  it("reads the named variables from the Cloudflare env of the request too", async () => {
    install({ mode: "token" })
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", ciTokenHash)
    const request = Object.assign(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }), {
      runtime: { name: "cloudflare", cloudflare: { context: { passThroughOnException: vi.fn(), waitUntil: vi.fn() }, env: { DB: {}, VITEHUB_CONSOLE_TOKEN_SHA256_CONSOLE: tokenHash } } },
    })
    expect((await send(request)).status).toBe(200)
  })

  it("ignores variables that only start like the name", async () => {
    install({ mode: "token" })
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", ciTokenHash)
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256X", tokenHash)
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256_lower", tokenHash)
    expect((await send(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }))).status).toBe(401)
  })

  it.each([
    ["a wrong token", `Bearer ${token}x`, "Bearer realm=\"vitehub-console\", error=\"invalid_token\""],
    ["the hash in place of the token", `Bearer ${tokenHash}`, "Bearer realm=\"vitehub-console\", error=\"invalid_token\""],
    ["a token shorter than 32 characters", "Bearer short-token", "Bearer realm=\"vitehub-console\", error=\"invalid_token\""],
    ["no token", undefined, "Bearer realm=\"vitehub-console\""],
    ["a cookie only", undefined, "Bearer realm=\"vitehub-console\""],
    ["a Basic credential", `Basic ${btoa(`user:${token}`)}`, "Bearer realm=\"vitehub-console\""],
  ])("rejects %s with 401 and a Bearer challenge", async (_name, authorization, challenge) => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", tokenHash)
    install({ mode: "token" })
    const response = await send(rpc({ ...(authorization ? { authorization } : {}), cookie: "better-auth.session_token=abc", [consoleRpcHeader]: "1" }))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(challenge)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_TOKEN_INVALID", fix: expect.stringContaining("VITEHUB_CONSOLE_AUTHORIZATION"), ok: false, status: 401 })
  })

  it.each([
    ["no hash is set", {}, "`VITEHUB_CONSOLE_TOKEN_SHA256` or a `VITEHUB_CONSOLE_TOKEN_SHA256_<NAME>` variable in the server environment, and none is set"],
    ["the hash is blank", { VITEHUB_CONSOLE_TOKEN_SHA256: "   " }, "none is set"],
    ["the hash is not 64 hex characters", { VITEHUB_CONSOLE_TOKEN_SHA256: tokenHash.slice(1) }, "`VITEHUB_CONSOLE_TOKEN_SHA256` is not 64 hex characters"],
    ["the hash has a non-hex character", { VITEHUB_CONSOLE_TOKEN_SHA256: `${tokenHash.slice(1)}g` }, "is not 64 hex characters"],
    ["a named variable is not a hash", { VITEHUB_CONSOLE_TOKEN_SHA256: tokenHash, VITEHUB_CONSOLE_TOKEN_SHA256_CI: token }, "`VITEHUB_CONSOLE_TOKEN_SHA256_CI` is not 64 hex characters"],
    ["a comma list", { VITEHUB_CONSOLE_TOKEN_SHA256: `${tokenHash},${ciTokenHash}` }, "`VITEHUB_CONSOLE_TOKEN_SHA256` is not 64 hex characters"],
    ["only the raw token is set", { VITEHUB_CONSOLE_TOKEN: token }, "`VITEHUB_CONSOLE_TOKEN` is set, but the server reads only `VITEHUB_CONSOLE_TOKEN_SHA256`"],
  ] satisfies Array<[string, Record<string, string>, string]>)("refuses every request with a diagnostic when %s", async (_name, env, message) => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", undefined)
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN", undefined)
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    install({ mode: "token" })
    const response = await send(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      code: "CONSOLE_TOKEN_NOT_CONFIGURED",
      docs: expect.stringContaining("#use-a-console-token"),
      fix: expect.stringMatching(/`openssl rand -hex 32`.*`printf %s "\$TOKEN" \| sha256sum`.*`wrangler secret put VITEHUB_CONSOLE_TOKEN_SHA256`/),
      message: expect.stringContaining(message),
    })
  })

  it("gives authorize the request with via: \"token\" and no user, and lets it limit the sections", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", tokenHash)
    const seen: ConsoleAuthorizeContext[] = []
    install({ authorize: (context) => {
      seen.push(context)
      // The union narrows: a token caller has no user.
      if (context.via === "token") expect(context.user).toBeUndefined()
      return { sections: ["kv"] }
    }, mode: "token" })
    const response = await send(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }))
    await expect(response.json()).resolves.toMatchObject({ ok: true, value: { scoped: true } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ via: "token" })
    expect(seen[0]?.request.headers.get("authorization")).toBe(`Bearer ${token}`)
    expect(seen[0]).not.toHaveProperty("user")
  })

  it("compares in constant time: it hashes the bearer once with SHA-256 and compares it with every digest", async () => {
    const expected = [tokenHash, ciTokenHash].map(hash => Uint8Array.from(Buffer.from(hash, "hex")))
    const digest = vi.spyOn(crypto.subtle, "digest")
    await expect(consoleTokenMatchesHash(expected, token)).resolves.toBe(true)
    await expect(consoleTokenMatchesHash(expected, ciToken)).resolves.toBe(true)
    await expect(consoleTokenMatchesHash(expected, `${token}x`)).resolves.toBe(false)
    await expect(consoleTokenMatchesHash(expected, tokenHash)).resolves.toBe(false)
    expect(digest.mock.calls.map(([algorithm]) => algorithm)).toEqual(["SHA-256", "SHA-256", "SHA-256", "SHA-256"])
    const hashed = digest.mock.calls.map(([, data]) => new TextDecoder().decode(data as Uint8Array))
    expect(hashed).toEqual([token, ciToken, `${token}x`, tokenHash])
  })

  it("never gives an Agent's operation calls the token context, which means a verified token", async () => {
    // A policy that trusts `via: "token"` must not reach Agents: they send no token.
    const authorize = vi.fn((context: ConsoleAuthorizeContext) => context.via === "token" ? { sections: ["kv"] } : false)
    install({ authorize, mode: "token" })
    await expect(installedOperationSectionResolver()?.({ user: null })).resolves.toEqual([])
    expect(authorize.mock.calls[0]?.[0]).toMatchObject({ via: "agent" })
    expect(authorize.mock.calls[0]?.[0]).not.toHaveProperty("user")
  })

  it("gives an Agent's operation calls the agent context with the user it acts for", async () => {
    const authorize = vi.fn((context: ConsoleAuthorizeContext) => context.via === "agent" ? { sections: ["kv:read"] } : false)
    install({ authorize, mode: "token" })
    await expect(installedOperationSectionResolver()?.({ user: { id: "agent-user" } })).resolves.toEqual(["kv:read"])
    expect(authorize.mock.calls[0]?.[0]).toMatchObject({ user: { id: "agent-user" }, via: "agent" })
  })
})

describe("console.origins", () => {
  it("accepts a listed origin with the token and answers with CORS headers", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", tokenHash)
    install({ mode: "token" })
    const response = await send(rpc({ authorization: `Bearer ${token}`, origin: consoleOrigin, "sec-fetch-site": "cross-site" }))
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    expect(response.headers.get("vary")).toBe("Origin")
    expect(response.headers.has("access-control-allow-credentials")).toBe(false)
    expect(response.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate")
  })

  it("rejects a cookie-only cross-origin call from a listed origin, with CORS headers so the Console reads why", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", tokenHash)
    install({ mode: "token" })
    const response = await send(rpc({ cookie: "better-auth.session_token=abc", origin: consoleOrigin, "sec-fetch-site": "cross-site" }))
    expect(response.status).toBe(401)
    expect(response.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    expect(response.headers.get("www-authenticate")).toBe("Bearer realm=\"vitehub-console\"")
  })

  it.each([
    ["an open Console", { mode: "open" }],
    ["a session Console", { check: async () => undefined, mode: "auth" }],
  ] satisfies Array<[string, ConsoleAccessPolicy]>)("never lets %s take a cross-origin call, even from a listed origin with a bearer header", async (_name, policy) => {
    install(policy)
    const response = await send(rpc({ authorization: `Bearer ${token}`, cookie: "better-auth.session_token=abc", origin: consoleOrigin, "sec-fetch-site": "cross-site" }))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_REJECTED" })
  })

  it.each([
    ["an unlisted origin", "https://evil.example", [consoleOrigin]],
    ["a listed origin when origins is []", consoleOrigin, []],
    ["the opaque null origin", "null", [consoleOrigin]],
  ])("rejects %s that sends a valid token", async (_name, origin, origins) => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", tokenHash)
    install({ mode: "token" }, origins)
    const response = await send(rpc({ authorization: `Bearer ${token}`, origin, "sec-fetch-site": "cross-site" }))
    expect(response.status).toBe(403)
    expect(response.headers.has("access-control-allow-origin")).toBe(false)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_REJECTED" })
  })

  it("keeps same-origin calls as they were", async () => {
    install({ mode: "open" })
    const sameOrigin: Array<Record<string, string>> = [{ origin: app }, { "sec-fetch-site": "same-origin" }, { [consoleRpcHeader]: "1" }]
    for (const headers of sameOrigin) {
      const response = await send(rpc(headers))
      expect(response.status).toBe(200)
      expect(response.headers.has("access-control-allow-origin")).toBe(false)
      expect(response.headers.has("vary")).toBe(false)
    }
    const foreign = await send(rpc({}))
    expect(foreign.status).toBe(403)
  })

  it("adds the Bearer challenge to a 401 of any access mode", async () => {
    install({ check: async () => new Response("Sign in.", { status: 401 }), mode: "auth" })
    const response = await send(rpc({ [consoleRpcHeader]: "1" }))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer realm=\"vitehub-console\"")
  })

  it("lets Channel replay take a token call from a listed origin", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", tokenHash)
    install({ mode: "token" })
    const replay = (origin: string) => channelReplayHandler.fetch(new Request(`${app}/_vitehub/channels/replay`, {
      body: JSON.stringify({}),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin },
      method: "POST",
    }))
    const listed = await replay(consoleOrigin)
    // The origin check passed: the route now asks for an Agent name.
    expect(listed.status).toBe(400)
    expect(listed.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    expect((await replay("https://evil.example")).status).toBe(403)
  })
})

describe("Console preflight", () => {
  function preflight(path: string, origin: string, method = "POST"): Request {
    return new Request(`${app}${path}`, { headers: { "access-control-request-headers": "authorization, content-type", "access-control-request-method": method, origin }, method: "OPTIONS" })
  }

  it.each(["/_vitehub/rpc/__call", "/_vitehub/rpc/__upload", "/_vitehub/auth/manage", "/_vitehub/env/manage", "/_vitehub/channels/replay", "/portal/_vitehub/rpc/__call"])("answers a listed origin at %s", async (path) => {
    installConsoleOrigins([consoleOrigin])
    const response = answerConsolePreflight(defineHandlerEvent(preflight(path, consoleOrigin)))
    expect(response?.status).toBe(204)
    expect(response?.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    expect(response?.headers.get("access-control-allow-methods")).toBe("POST")
    expect(response?.headers.get("access-control-allow-headers")).toBe("authorization, content-type, x-vitehub-console")
    expect(response?.headers.get("vary")).toContain("Origin")
    expect(response?.headers.has("access-control-allow-credentials")).toBe(false)
  })

  it("rejects an unlisted origin and leaves other requests to the app", async () => {
    installConsoleOrigins([consoleOrigin])
    const rejected = answerConsolePreflight(defineHandlerEvent(preflight("/_vitehub/rpc/__call", "https://evil.example")))
    expect(rejected?.status).toBe(403)
    expect(rejected?.headers.has("access-control-allow-origin")).toBe(false)
    await expect(rejected?.json()).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_NOT_ALLOWED", message: expect.stringContaining("https://evil.example") })
    expect(answerConsolePreflight(defineHandlerEvent(preflight("/api/items", consoleOrigin)))).toBeUndefined()
    expect(answerConsolePreflight(defineHandlerEvent(new Request(`${app}/_vitehub/rpc/__call`, { headers: { origin: consoleOrigin }, method: "OPTIONS" })))).toBeUndefined()
  })

  it("registers a Nitro plugin, not a middleware, and only for cross-origin calls", () => {
    const other: { handlers: Array<{ handler: string, middleware?: boolean }>, plugins?: string[] } = { handlers: [] }
    addConsoleRpcHandler(other, "/runtime", "/", [])
    expect(other.plugins ?? []).not.toContain("/runtime/server/console-preflight.js")
    const config: { handlers: Array<{ handler: string, middleware?: boolean }>, plugins: string[] } = { handlers: [], plugins: ["app-plugin.js"] }
    addConsoleRpcHandler(config, "/runtime", "/", [], false, true)
    expect(config.plugins).toEqual(["/runtime/server/console-preflight.js", "app-plugin.js"])
    expect(config.handlers.some(handler => handler.handler.endsWith("console-preflight.js"))).toBe(false)
    // A replayed config without cross-origin calls drops the plugin again.
    addConsoleRpcHandler(config, "/runtime", "/", [])
    expect(config.plugins).toEqual(["app-plugin.js"])
  })

  it("answers on Nitro 3 before app middleware and app Auth that reject every request without a session", async () => {
    installConsoleOrigins([consoleOrigin])
    const database = new DatabaseSync(":memory:")
    onTestFinished(() => database.close())
    const definition = defineAuth(() => ({ baseURL: app, database, secret: "test-secret-at-least-32-bytes-long" }))
    await (await createAuthForRequest(definition, new Request(app)).$context).runMigrations()
    const appAuth = createAuthAccessHandler([{ authorize: true, route: "/**" }], definition)
    // Nitro adds scanned `server/middleware/` files and configured middleware, then runs the plugins.
    const h3 = new H3()
    h3.use(() => new Response("Sign in first.", { status: 401 }))
    h3.use(async event => await appAuth(event as never) ?? undefined)
    h3.all("/**", () => new Response("route"))
    consolePreflightPlugin({ h3 })
    const answered = await h3.fetch(preflight("/_vitehub/rpc/__call", consoleOrigin))
    expect(answered.status).toBe(204)
    expect(answered.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    // The app middleware is active: the actual call never reaches the route without its session.
    expect((await h3.fetch(rpc({ authorization: `Bearer ${token}`, origin: consoleOrigin }))).status).toBe(401)
  })
})

describe("Console data route responses", () => {
  it("adds Origin to an existing Vary list and exposes the challenge", async () => {
    installConsoleOrigins([consoleOrigin])
    const route = withConsoleCors(async () => new Response("no", { headers: { vary: "Accept-Encoding, origin" }, status: 401 }))
    const response = await route(requestEvent(new Request(app, { headers: { origin: consoleOrigin } })))
    expect(response.headers.get("vary")).toBe("Accept-Encoding, origin")
    const other = await withConsoleCors(async () => new Response("no", { headers: { vary: "Accept-Encoding" } }))(requestEvent(new Request(app, { headers: { origin: consoleOrigin } })))
    expect(other.headers.get("vary")).toBe("Accept-Encoding, Origin")
    expect(response.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate")
    expect(response.headers.get("www-authenticate")).toBe("Bearer realm=\"vitehub-console\"")
  })

  it("keeps the status when the server Response class ignores the status of a Response passed as init", async () => {
    installConsoleOrigins([consoleOrigin])
    const native = globalThis.Response
    onTestFinished(() => {
      globalThis.Response = native
    })
    // Like srvx on Node.js: the init is spread, so the status getter of a Response init is lost.
    class SpreadResponse extends native {
      constructor(body?: ConstructorParameters<typeof native>[0], init?: ResponseInit) {
        super(body, init ? { ...init } : init)
      }
    }
    globalThis.Response = SpreadResponse
    const response = await withConsoleCors(async () => new native("no", { status: 401 }))(requestEvent(new Request(app, { headers: { origin: consoleOrigin } })))
    expect(response.status).toBe(401)
    expect(response.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
  })

  it("lets Env management take a token call from a listed origin, and still lets the bridge decide", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", tokenHash)
    install({ mode: "token" })
    installConsoleSections("/console-token-env", ["env"])
    const manage = vi.fn(async (_request: Request, _options?: { allowedOrigin?: string }) => Response.json({ ok: true }))
    installConsoleEnv("/console-token-env", { entries: [] }, manage)
    const call = (origin?: string) => defineHandler(envManageHandler).fetch(new Request(`${app}/_vitehub/env/manage`, {
      body: JSON.stringify({ action: "inspect", path: "token" }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(origin ? { origin } : {}) },
      method: "POST",
    }))
    const listed = await call(consoleOrigin)
    expect(listed.status).toBe(200)
    expect(listed.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    expect(manage.mock.calls.at(-1)?.[1]).toEqual({ allowedOrigin: consoleOrigin })
    await call("https://evil.example")
    expect(manage.mock.calls.at(-1)?.[1]).toEqual({})
    await call()
    expect(manage.mock.calls.at(-1)?.[1]).toEqual({})
  })

  it("runs a Schedule with the token from a listed origin, and keeps the section and write checks", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN_SHA256", tokenHash)
    let sections: string[] | undefined
    install({ authorize: () => sections ? { sections } : true, mode: "token" })
    const run = (headers: Record<string, string>) => defineHandler(scheduleRunHandler).fetch(new Request(`${app}/_vitehub/schedules/run`, {
      body: JSON.stringify({ name: "nightly" }),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    }))
    const listed = await run({ authorization: `Bearer ${token}`, origin: consoleOrigin })
    // The access and origin checks passed: the route now looks for the Schedule.
    expect(listed.status).toBe(404)
    await expect(listed.json()).resolves.toMatchObject({ message: expect.stringContaining("manual: true") })
    expect(listed.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    const anonymous = await run({ origin: consoleOrigin })
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer realm=\"vitehub-console\"")
    expect((await run({ authorization: `Bearer ${token}`, origin: "https://evil.example" })).status).toBe(403)
    sections = ["schedules:read"]
    expect((await run({ authorization: `Bearer ${token}` })).status).toBe(403)
    sections = ["kv"]
    expect((await run({ authorization: `Bearer ${token}` })).status).toBe(403)
  })
})

describe("Console origin and token options", () => {
  it("defaults origins to the hosted Console and keeps them only for the bearer modes", () => {
    expect(resolveConsoleOrigins(undefined)).toEqual([consoleOrigin])
    expect(resolveConsoleAccessBuild({ auth: "token" }, { root: process.cwd() })).toEqual({ mode: "token", origins: [consoleOrigin] })
    expect(resolveConsoleAccessBuild({ auth: "token", origins: [] }, { root: process.cwd() })).toEqual({ mode: "token", origins: [] })
    expect(resolveConsoleAccessBuild({ auth: false, origins: [consoleOrigin] }, { root: process.cwd() })).not.toHaveProperty("origins")
    expect(resolveConsoleOptions({ auth: "token" })).toEqual({ auth: "token" })
  })

  it.each([
    "https://console.example.com",
    "http://localhost:5173",
    "http://127.0.0.1:8787",
    "http://localhost",
  ])("accepts %s", (origin) => {
    expect(resolveConsoleOptions({ auth: "token", origins: [origin] })).toEqual({ auth: "token", origins: [origin] })
  })

  it.each([
    ["https://console.example.com/", "Use \"https://console.example.com\""],
    ["https://console.example.com/app", "Use \"https://console.example.com\""],
    ["https://Console.example.com", "Use \"https://console.example.com\""],
    ["http://console.example.com", "https:// origin"],
    ["*", "https:// origin"],
    ["null", "https:// origin"],
    [42, "42"],
  ])("rejects %s", (origin, message) => {
    expect(() => resolveConsoleOptions({ auth: "token", origins: [origin] })).toThrow(message)
  })

  it("rejects origins that are not a list, and an unknown auth string", () => {
    expect(() => resolveConsoleOptions({ auth: "token", origins: "https://console.vitehub.dev" })).toThrow("console.origins must be a list")
    expect(() => resolveConsoleOptions({ auth: "tokens" })).toThrow("\"token\"")
  })
})

/** An H3 2 event of a Fetch request, as Nitro 3 gives a middleware. */
function defineHandlerEvent(request: Request) {
  return requestEvent(request)
}
