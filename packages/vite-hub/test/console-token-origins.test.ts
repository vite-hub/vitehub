import { DatabaseSync } from "node:sqlite"

import { defineAuth } from "@vite-hub/auth"
import { createAuthAccessHandler, createAuthForRequest } from "@vite-hub/auth/server"
import { defineHandler, H3 } from "h3"
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest"

import { requestEvent } from "./console-event.ts"

import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import consolePreflightPlugin from "../src/console/runtime/server/console-preflight.ts"
import { answerConsolePreflight, installConsoleOrigins, isConsoleCrossOriginCall, withConsoleCors } from "../src/console/runtime/server/cors.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import consoleRpcHandler from "../src/console/runtime/server/rpc.ts"
import { addConsoleRpcHandler } from "../src/console/nitro.ts"
import { resolveConsoleAccessBuild, resolveConsoleOptions, resolveConsoleOrigins } from "../src/console/vite.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleAccessPolicy } from "../src/console/runtime/server/access.ts"

const app = "https://app.example.com"
const consoleOrigin = "https://console.vitehub.dev"
const token = "test-console-token-0123456789abcdef"
const ci = await consoleTestKey("CI")
const policyKey = Symbol.for("vitehub.console.access")
const originsKey = Symbol.for("vitehub.console.origins")

function install(policy: ConsoleAccessPolicy, origins: readonly string[] = [consoleOrigin]): void {
  installConsoleAccess(policy)
  installConsoleOrigins(origins)
}

function rpc(headers: Record<string, string>, init: { operation?: string, path?: string } = {}): Request {
  return new Request(`${app}${init.path ?? "/_vitehub/rpc"}`, {
    body: operationRpcBody(init.operation ?? "sections.list", {}),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  })
}

function send(request: Request): Promise<Response> {
  return defineHandler(consoleRpcHandler).fetch(request)
}

afterEach(() => {
  installConsoleDevelopment("/test/app", false)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  Reflect.deleteProperty(globalThis, originsKey)
  Reflect.deleteProperty(globalThis, policyKey)
})

describe("console.origins", () => {
  it("rejects an unsigned cross-origin call from a listed origin, with CORS headers so the Console reads why", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_KEY_CI", ci.publicKey)
    install({ mode: "token" })
    const response = await send(rpc({ authorization: `Bearer ${token}`, cookie: "better-auth.session_token=abc", origin: consoleOrigin, "sec-fetch-site": "cross-site" }))
    expect(response.status).toBe(401)
    expect(response.headers.get("access-control-allow-origin")).toBe(consoleOrigin)
    expect(response.headers.get("vary")).toBe("Origin")
    expect(response.headers.has("access-control-allow-credentials")).toBe(false)
    expect(response.headers.get("access-control-expose-headers")).toBe("WWW-Authenticate")
    expect(response.headers.get("www-authenticate")).toBe("VitehubSignature realm=\"vitehub-console\"")
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code: "CONSOLE_SIGNATURE_MISSING" })
  })

  it("refuses a signed call from a listed origin: browsers do not sign, so only OAuth calls cross origins", async () => {
    vi.stubEnv("VITEHUB_CONSOLE_KEY_CI", ci.publicKey)
    install({ mode: "token" })
    const response = await send(await signedRpcRequest({ headers: { origin: consoleOrigin, "sec-fetch-site": "cross-site" }, key: ci.key }))
    expect(response.status).toBe(403)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_REJECTED" })
  })

  it.each([
    ["an open Console", { mode: "open" }],
    ["a session Console", { check: async () => undefined, mode: "auth" }],
  ] satisfies Array<[string, ConsoleAccessPolicy]>)("never lets %s in production take a cross-origin call, even from a listed origin with a bearer header", async (_name, policy) => {
    install(policy)
    const response = await send(rpc({ authorization: `Bearer ${token}`, cookie: "better-auth.session_token=abc", origin: consoleOrigin, "sec-fetch-site": "cross-site" }))
    expect(response.status).toBe(403)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_REJECTED" })
  })

  it.each([
    ["an unlisted origin", "https://evil.example", [consoleOrigin]],
    ["a listed origin when origins is []", consoleOrigin, []],
    ["the opaque null origin", "null", [consoleOrigin]],
  ])("rejects %s that sends a valid signature", async (_name, origin, origins) => {
    vi.stubEnv("VITEHUB_CONSOLE_KEY_CI", ci.publicKey)
    install({ mode: "token" }, origins)
    const response = await send(await signedRpcRequest({ headers: { origin, "sec-fetch-site": "cross-site" }, key: ci.key }))
    expect(response.status).toBe(403)
    expect(response.headers.has("access-control-allow-origin")).toBe(false)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_REJECTED" })
  })

  it.each(["local", "open"] as const)("lets the hosted Console call a %s development server from a listed origin without a token", (mode) => {
    installConsoleDevelopment("/test/app", true)
    install({ mode })
    expect(isConsoleCrossOriginCall(rpc({ origin: consoleOrigin, "sec-fetch-site": "cross-site" }), { mode, sections: "all" })).toBe(true)
  })

  it.each(["local", "open"] as const)("refuses a listed origin without a token on a %s production server", (mode) => {
    installConsoleDevelopment("/test/app", false)
    install({ mode })
    expect(isConsoleCrossOriginCall(rpc({ origin: consoleOrigin }), { mode, sections: "all" })).toBe(false)
  })

  it("refuses an unlisted origin on a development server without sign-in", () => {
    installConsoleDevelopment("/test/app", true)
    install({ mode: "open" })
    expect(isConsoleCrossOriginCall(rpc({ origin: "https://evil.example" }), { mode: "open", sections: "all" })).toBe(false)
  })

  it("takes only an OAuth bearer across origins, in development too", () => {
    installConsoleDevelopment("/test/app", true)
    install({ mode: "token" })
    expect(isConsoleCrossOriginCall(rpc({ origin: consoleOrigin }), { mode: "token", sections: "all" })).toBe(false)
    expect(isConsoleCrossOriginCall(rpc({ authorization: `Bearer ${token}`, origin: consoleOrigin }), { mode: "token", sections: "all", via: "console" })).toBe(false)
    expect(isConsoleCrossOriginCall(rpc({ authorization: `Bearer ${token}`, origin: consoleOrigin }), { mode: "auth", sections: "all", via: "oauth" })).toBe(true)
    expect(isConsoleCrossOriginCall(rpc({ authorization: `Bearer ${token}`, origin: consoleOrigin }), { mode: "auth", sections: "all" })).toBe(false)
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
})

describe("Console preflight", () => {
  function preflight(path: string, origin: string, method = "POST"): Request {
    return new Request(`${app}${path}`, { headers: { "access-control-request-headers": "authorization, content-type", "access-control-request-method": method, origin }, method: "OPTIONS" })
  }

  it.each(["/_vitehub/rpc", "/_vitehub/auth/manage", "/_vitehub/env/manage", "/portal/_vitehub/rpc"])("answers a listed origin at %s", async (path) => {
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
    const rejected = answerConsolePreflight(defineHandlerEvent(preflight("/_vitehub/rpc", "https://evil.example")))
    expect(rejected?.status).toBe(403)
    expect(rejected?.headers.has("access-control-allow-origin")).toBe(false)
    await expect(rejected?.json()).resolves.toMatchObject({ code: "CONSOLE_ORIGIN_NOT_ALLOWED", message: expect.stringContaining("https://evil.example") })
    expect(answerConsolePreflight(defineHandlerEvent(preflight("/api/items", consoleOrigin)))).toBeUndefined()
    expect(answerConsolePreflight(defineHandlerEvent(new Request(`${app}/_vitehub/rpc`, { headers: { origin: consoleOrigin }, method: "OPTIONS" })))).toBeUndefined()
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
    const answered = await h3.fetch(preflight("/_vitehub/rpc", consoleOrigin))
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
})

describe("Console origin and token options", () => {
  it("defaults origins to the hosted Console and keeps them for bearer modes and development without sign-in", () => {
    expect(resolveConsoleOrigins(undefined)).toEqual([consoleOrigin])
    expect(resolveConsoleAccessBuild({ auth: "token" }, { root: process.cwd() })).toEqual({ mode: "token", origins: [consoleOrigin] })
    expect(resolveConsoleAccessBuild({ auth: "token", origins: [] }, { root: process.cwd() })).toEqual({ mode: "token", origins: [] })
    expect(resolveConsoleAccessBuild({ auth: false }, { root: process.cwd() })).toEqual({ mode: "open", origins: [consoleOrigin] })
    expect(resolveConsoleAccessBuild({ auth: false, origins: [] }, { root: process.cwd() })).toEqual({ mode: "open", origins: [] })
    expect(resolveConsoleAccessBuild({ auth: "app" }, { root: process.cwd() })).not.toHaveProperty("origins")
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
