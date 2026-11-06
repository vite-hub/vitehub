import { DatabaseSync } from "node:sqlite"

import { defineAuth } from "@vite-hub/auth"
import { createAuthAccessHandler, createAuthForRequest } from "@vite-hub/auth/server"
import { defineHandler, H3 } from "h3"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import channelReplayHandler from "../src/console/runtime/server/channel-replay.ts"
import consolePreflightHandler from "../src/console/runtime/server/console-preflight.ts"
import { consoleTokensMatch } from "../src/console/runtime/server/console-token.ts"
import { installConsoleOrigins } from "../src/console/runtime/server/cors.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"
import { addConsoleRpcHandler } from "../src/console/nitro.ts"
import { resolveConsoleAccessBuild, resolveConsoleOptions, resolveConsoleOrigins } from "../src/console/vite.ts"

import type { ConsoleAuthorizeContext } from "../src/console/auth-types.ts"
import type { ConsoleAccessPolicy } from "../src/console/runtime/server/access.ts"

const app = "https://app.example.com"
const consoleOrigin = "https://console.vitehub.dev"
const token = "test-console-token-0123456789abcdef"
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
  it("accepts the token from VITEHUB_CONSOLE_TOKEN", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN", token)
    install({ mode: "token" })
    const response = await send(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }))
    expect(response.status, await response.clone().text()).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true })
    expect(response.headers.has("access-control-allow-origin")).toBe(false)
  })

  it("reads the token from the Cloudflare env of the request", async () => {
    install({ mode: "token" })
    const request = Object.assign(rpc({ authorization: `Bearer ${token}`, [consoleRpcHeader]: "1" }), {
      runtime: { name: "cloudflare", cloudflare: { context: { passThroughOnException: vi.fn(), waitUntil: vi.fn() }, env: { VITEHUB_CONSOLE_TOKEN: token } } },
    })
    expect((await send(request)).status).toBe(200)
  })

  it.each([
    ["a wrong token", `Bearer ${token}x`, "Bearer realm=\"vitehub-console\", error=\"invalid_token\""],
    ["no token", undefined, "Bearer realm=\"vitehub-console\""],
    ["a cookie only", undefined, "Bearer realm=\"vitehub-console\""],
    ["a Basic credential", `Basic ${btoa(`user:${token}`)}`, "Bearer realm=\"vitehub-console\""],
  ])("rejects %s with 401 and a Bearer challenge", async (_name, authorization, challenge) => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN", token)
    install({ mode: "token" })
    const response = await send(rpc({ ...(authorization ? { authorization } : {}), cookie: "better-auth.session_token=abc", [consoleRpcHeader]: "1" }))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(challenge)
    await expect(response.json()).resolves.toMatchObject({ code: "CONSOLE_TOKEN_INVALID", fix: expect.stringContaining("VITEHUB_CONSOLE_AUTHORIZATION"), ok: false, status: 401 })
  })

  it.each([
    ["is not set", undefined, "it is not set"],
    ["is blank", "   ", "it is not set"],
    ["is too short to be a secret", "short-token", "fewer than 32 characters"],
  ])("refuses every request with a diagnostic when VITEHUB_CONSOLE_TOKEN %s", async (_name, value, message) => {
    if (value !== undefined) vi.stubEnv("VITEHUB_CONSOLE_TOKEN", value)
    else vi.stubEnv("VITEHUB_CONSOLE_TOKEN", undefined)
    install({ mode: "token" })
    const response = await send(rpc({ authorization: `Bearer ${value ?? token}`, [consoleRpcHeader]: "1" }))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      code: "CONSOLE_TOKEN_NOT_CONFIGURED",
      docs: expect.stringContaining("#use-a-console-token"),
      fix: expect.stringMatching(/openssl rand -base64 32.*wrangler secret put VITEHUB_CONSOLE_TOKEN/),
      message: expect.stringMatching(new RegExp(`VITEHUB_CONSOLE_TOKEN.*${message}`)),
    })
  })

  it("gives authorize the request with via: \"token\" and no user, and lets it limit the sections", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN", token)
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

  it("compares tokens in constant time: both sides are hashed with SHA-256 before the comparison", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest")
    await expect(consoleTokensMatch(token, token)).resolves.toBe(true)
    await expect(consoleTokensMatch(token, `${token}x`)).resolves.toBe(false)
    await expect(consoleTokensMatch(token, "x")).resolves.toBe(false)
    expect(digest).toHaveBeenCalledTimes(6)
    for (const [algorithm] of digest.mock.calls) expect(algorithm).toBe("SHA-256")
    const hashed = digest.mock.calls.map(([, data]) => new TextDecoder().decode(data as Uint8Array))
    expect(hashed).toEqual([token, token, token, `${token}x`, token, "x"])
  })
})

describe("console.origins", () => {
  it("accepts a listed origin with the token and answers with CORS headers", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN", token)
    install({ mode: "token" })
    const response = await send(rpc({ authorization: `Bearer ${token}`, origin: consoleOrigin, "sec-fetch-site": "cross-site" }))
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    expect(response.headers.get("vary")).toBe("Origin")
    expect(response.headers.has("access-control-allow-credentials")).toBe(false)
    expect(response.headers.has("access-control-expose-headers")).toBe(false)
  })

  it("rejects a cookie-only cross-origin call from a listed origin, with CORS headers so the Console reads why", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN", token)
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
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN", token)
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
    vi.stubEnv("VITEHUB_CONSOLE_TOKEN", token)
    install({ mode: "token" })
    const replay = (origin: string) => channelReplayHandler({ method: "POST", req: new Request(`${app}/_vitehub/channels/replay`, {
      body: JSON.stringify({}),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin },
      method: "POST",
    }) })
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
    const response = consolePreflightHandler(defineHandlerEvent(preflight(path, consoleOrigin)))
    expect(response?.status).toBe(204)
    expect(response?.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    expect(response?.headers.get("access-control-allow-methods")).toBe("POST")
    expect(response?.headers.get("access-control-allow-headers")).toBe("authorization, content-type, x-vitehub-console")
    expect(response?.headers.get("vary")).toContain("Origin")
    expect(response?.headers.has("access-control-allow-credentials")).toBe(false)
  })

  it("rejects an unlisted origin and leaves other requests to the app", async () => {
    installConsoleOrigins([consoleOrigin])
    const rejected = consolePreflightHandler(defineHandlerEvent(preflight("/_vitehub/rpc/__call", "https://evil.example")))
    expect(rejected?.status).toBe(403)
    expect(rejected?.headers.has("access-control-allow-origin")).toBe(false)
    await expect(rejected?.json()).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_NOT_ALLOWED", message: expect.stringContaining("https://evil.example") })
    expect(consolePreflightHandler(defineHandlerEvent(preflight("/api/items", consoleOrigin)))).toBeUndefined()
    expect(consolePreflightHandler(defineHandlerEvent(new Request(`${app}/_vitehub/rpc/__call`, { headers: { origin: consoleOrigin }, method: "OPTIONS" })))).toBeUndefined()
  })

  it("answers before app Auth middleware that rejects every request without a session", async () => {
    installConsoleOrigins([consoleOrigin])
    const database = new DatabaseSync(":memory:")
    onTestFinished(() => database.close())
    const definition = defineAuth(() => ({ baseURL: app, database, secret: "test-secret-at-least-32-bytes-long" }))
    await (await createAuthForRequest(definition, new Request(app)).$context).runMigrations()
    const appAuth = createAuthAccessHandler([{ authorize: true, route: "/**" }], definition)
    const config: { handlers: Array<{ handler: string, middleware?: boolean, route?: string }> } = { handlers: [{ handler: "app-auth", middleware: true, route: "/**" }] }
    const other = { handlers: [{ handler: "app-auth", middleware: true, route: "/**" }] }
    addConsoleRpcHandler(other, "/runtime", "/", [])
    // Other access modes take no cross-origin call, so they get no preflight middleware.
    expect(other.handlers.some(handler => handler.handler.endsWith("console-preflight.js"))).toBe(false)
    addConsoleRpcHandler(config, "/runtime", "/", [], false, true)
    const middleware = config.handlers.filter(handler => handler.middleware)
    expect(middleware.map(handler => handler.handler)).toEqual(["/runtime/server/console-preflight.js", "app-auth"])
    // Nitro runs middleware in this order before any route handler.
    const h3 = new H3()
    for (const registration of middleware) {
      h3.use(registration.handler === "app-auth"
        ? async event => await appAuth(event as never) ?? undefined
        : event => consolePreflightHandler(event))
    }
    h3.all("/**", () => new Response("route"))
    const answered = await h3.fetch(preflight("/_vitehub/rpc/__call", consoleOrigin))
    expect(answered.status).toBe(204)
    expect(answered.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    // App Auth is active: the actual call without a session never reaches the route.
    expect((await h3.fetch(rpc({ authorization: `Bearer ${token}`, origin: consoleOrigin }))).status).toBe(401)
  })
})

describe("Console origin and token options", () => {
  it("defaults origins to the hosted Console and keeps them only for the token mode", () => {
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
function defineHandlerEvent(request: Request): { method: string, req: Request } {
  return { method: request.method, req: request }
}
