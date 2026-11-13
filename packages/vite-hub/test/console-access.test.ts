import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it, vi } from "vitest"

import { defineConsoleAuthorize } from "../src/console/auth.ts"
import { consoleRpcHeader } from "../src/console/runtime/rpc.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"

import { bindConsoleAccess, consoleRealtimeAccess, installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import { consoleOperationRegistry, handleConsoleRpcRequest } from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consoleVitePlugin, resolveConsoleAccessBuild, resolveConsoleOptions } from "../src/console/vite.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"
import { handleConsoleRpcRequest as handleGuardedRpcRequest } from "./support/console-rpc.ts"

import type { ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { ConsoleAuthorize } from "../src/console/auth.ts"
import type { ConsoleAccess, ConsoleAccessPolicy } from "../src/console/runtime/server/access.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"
import { requestEvent, routeRequest } from "./console-event.ts"
import { consoleEvent } from "./console-event.ts"
import { signedConsoleAccess } from "./support/console-signature.ts"
import { operationRpcBody, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const policyKey = Symbol.for("vitehub.console.access")
const serverRoot = fileURLToPath(new URL("../src/console/runtime/server/", import.meta.url))
// The page tools session reads no Console data: it lists the page tools of a visitor, and the Console link it can list
// gives no access.
const pageRoutes = new Set(["page-session.ts"])

function event(headers: Record<string, string> = {}): ConsoleRequestEvent {
  return requestEvent(new Request("http://vitehub.local/_vitehub/api/data", { headers }))
}

async function run(policy: ConsoleAccessPolicy | undefined, request = event()) {
  if (policy) installConsoleAccess(policy)
  else Reflect.deleteProperty(globalThis, policyKey)
  const handler = vi.fn((_event: ConsoleRequestEvent, access: ConsoleAccess) => access)
  const result = await withConsoleAccess(handler, { anySection: true })(request)
  return { handler, result }
}

async function rejection(result: unknown): Promise<{ code: string, docs: string, fix: string, message: string, status: number }> {
  if (!(result instanceof Response)) throw new TypeError("Expected a rejection Response.")
  const body: unknown = await result.json()
  const field = (name: string) => body instanceof Object && name in body ? String(Reflect.get(body, name)) : ""
  return { code: field("code"), docs: field("docs"), fix: field("fix"), message: field("message"), status: result.status }
}

afterEach(() => {
  installConsoleDevelopment("/test/app", false)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  Reflect.deleteProperty(globalThis, policyKey)
})

describe("Console data route contract", () => {
  it("guards every Console data route with withConsoleAccess()", async () => {
    const files = (await readdir(serverRoot)).filter(file => file.endsWith(".ts")).sort()
    const routes: string[] = []
    for (const file of files) {
      if (!/^export default /m.test(await readFile(join(serverRoot, file), "utf8"))) continue
      routes.push(file)
    }
    expect(routes).toContain("invocation-workspace.get.ts")
    expect(routes).toContain("rpc.ts")

    for (const file of routes.filter(route => !pageRoutes.has(route))) {
      Reflect.deleteProperty(globalThis, policyKey)
      const route: unknown = (await import(join(serverRoot, file))).default
      // HTTP routes are Fetchables. Operation handlers are functions of a request event.
      const fetchRoute: unknown = route instanceof Object ? Reflect.get(route, "fetch") : undefined
      const result: unknown = fetchRoute instanceof Function
        ? await Reflect.apply(fetchRoute, route, [routeRequest(event())])
        : route instanceof Function ? await route(event()) : undefined
      if (result === undefined) throw new TypeError(`${file} must default-export a route.`)
      expect(result, `${file} must call withConsoleAccess() before it reads data`).toBeInstanceOf(Response)
      await expect(rejection(result), file).resolves.toMatchObject({ code: "CONSOLE_ACCESS_NOT_CONFIGURED", message: expect.stringContaining("Console access is not configured"), status: 500 })
    }
  })
})

describe("Console access policies", () => {
  it("takes console: true as signed calls, and console.auth: false as an open development Console", async () => {
    expect(resolveConsoleOptions(true)).toEqual({})
    expect(resolveConsoleOptions({ auth: false })).toEqual({ auth: false })
    expect(resolveConsoleOptions(false)).toBeUndefined()
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-options-"))
    try {
      expect(resolveConsoleAccessBuild({}, { root })).toEqual({ mode: "token" })
      expect(resolveConsoleAccessBuild({ auth: false }, { root })).toEqual({ mode: "open" })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    { option: { auth: "token" }, fix: "Signed calls are the default now. Remove console.auth, or set console: true." },
    { option: { auth: "app" }, fix: "Apps do not sign people in to the Console. Set console: true" },
    { option: { auth: { provider: "github", allowedEmails: ["ada@example.com"] } }, fix: "People sign in to the ViteHub Console at https://console.vitehub.dev" },
    { option: { auth: { provider: "cloudflare-access" } }, fix: "was removed" },
    { option: { auth: {} }, fix: "was removed" },
    { option: { origins: ["https://console.vitehub.dev"] }, fix: "console.origins was removed. Apps take no Console calls from browsers." },
    { option: { mcp: { resource: "https://app.example.com/_vitehub/mcp" } }, fix: "console.mcp was removed. Apps do not serve a Console MCP at /_vitehub/mcp. Agents use the ViteHub MCP of the Console at https://console.vitehub.dev/mcp." },
    { option: { signInPage: "/sign-in" }, fix: "console.signInPage was removed." },
    { option: { embed: true }, fix: "console.embed was removed." },
  ])("refuses the removed option $option with its fix", ({ option, fix }) => {
    expect(() => resolveConsoleOptions(option)).toThrow(expect.objectContaining({ code: "VITE_HUB_B0020", message: expect.stringContaining(fix) }))
  })

  it("refuses an unknown console.auth value", () => {
    expect(() => resolveConsoleOptions({ auth: "public" })).toThrow(expect.objectContaining({ code: "VITE_HUB_B0004" }))
    expect(() => resolveConsoleOptions("yes")).toThrow(expect.objectContaining({ code: "VITE_HUB_B0004" }))
  })

  it("hides the sections that console.sections turns off, and accepts only false", () => {
    const root = process.cwd()
    expect(resolveConsoleAccessBuild(resolveConsoleOptions({ auth: false, sections: { content: false } })!, { root })).toEqual({ hiddenSections: ["content"], mode: "open" })
    expect(resolveConsoleAccessBuild(resolveConsoleOptions({ auth: false, sections: {} })!, { root })).toEqual({ mode: "open" })
    expect(() => resolveConsoleOptions({ auth: false, sections: { content: true } })).toThrow(/console\.sections maps a section id to false/)
    expect(() => resolveConsoleOptions({ auth: false, sections: ["content"] })).toThrow(/console\.sections/)
  })

  it("accepts access callbacks created in another runtime realm", async () => {
    const authorize = runInNewContext("({ request }) => request.headers.get('x-role') === 'admin'") as unknown as ConsoleAuthorize
    const handler = runInNewContext("(_event, access) => access.mode") as (_event: ConsoleRequestEvent, access: ConsoleAccess) => string

    installConsoleAccess({ mode: "open", authorize: defineConsoleAuthorize(authorize) })
    await expect(withConsoleAccess(handler, { anySection: true })(event({ "x-role": "admin" }))).resolves.toBe("open")
  })

  it("accepts section results created in another runtime realm", async () => {
    const authorize = runInNewContext("() => ({ sections: ['content'] })") as unknown as ConsoleAuthorize

    installConsoleAccess({ mode: "open", authorize: defineConsoleAuthorize(authorize) })
    const result = await withConsoleAccess((_event, access) => access.sections, { section: "content" })(event())

    expect(result).toEqual(["content"])
  })

  it("accepts a dynamic route scope created in another runtime realm", async () => {
    const section = runInNewContext("() => 'content'") as () => "content"

    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["content"] }) })
    await expect(withConsoleAccess(() => "allowed", { section })(event())).resolves.toBe("allowed")
  })

  it("sends a Response of this runtime that a callback from another realm returns", async () => {
    const authorize = runInNewContext("() => new Response('Sign in elsewhere.', { status: 401 })", { Response }) as unknown as ConsoleAuthorize

    installConsoleAccess({ mode: "open", authorize: defineConsoleAuthorize(authorize) })
    const result = await withConsoleAccess(() => "unreachable", { anySection: true })(event())

    expect(result).toMatchObject({ status: 401 })
    await expect((result as Response).text()).resolves.toBe("Sign in elsewhere.")
  })

  it("sends a Response subclass of this runtime", async () => {
    class CustomResponse extends Response {}

    installConsoleAccess({ mode: "open", authorize: () => new CustomResponse("Subclass response.", { status: 202 }) })
    const result = await withConsoleAccess(() => "unreachable", { anySection: true })(event())

    expect(result).toMatchObject({ status: 202 })
    await expect((result as Response).text()).resolves.toBe("Subclass response.")
  })

  it("fails closed when no policy is installed", async () => {
    const { handler, result } = await run(undefined)
    expect(handler).not.toHaveBeenCalled()
    await expect(rejection(result)).resolves.toMatchObject({ status: 500 })
  })

  it.each([
    { name: "absent", process: undefined },
    { name: "partial", process: {} },
  ])("fails closed for a local Console when the process is $name", async ({ process }) => {
    vi.stubGlobal("process", process)
    const denied = await run({ mode: "local" })
    expect(denied.handler).not.toHaveBeenCalled()
    await expect(rejection(denied.result)).resolves.toMatchObject({ code: "CONSOLE_DEVELOPMENT_ONLY", status: 403 })
  })

  it("keeps the local development Console open and fails closed in production", async () => {
    installConsoleDevelopment("/test/app", true)
    // A development Console without sign-in serves only this machine.
    const allowed = await run({ mode: "local" }, requestEvent(new Request("http://localhost:3000/_vitehub/api/data"), { remoteAddress: "127.0.0.1" }))
    expect(allowed.result).toEqual({ mode: "local", sections: "all" })
    expect(Object.isFrozen(allowed.result)).toBe(true)

    installConsoleDevelopment("/test/app", false)
    const denied = await run({ mode: "local" })
    expect(denied.handler).not.toHaveBeenCalled()
    await expect(rejection(denied.result)).resolves.toMatchObject({ code: "CONSOLE_DEVELOPMENT_ONLY", fix: expect.stringContaining("For production"), message: expect.stringContaining("only on the development server"), status: 403 })
  })

  it("runs console.authorize for open access", async () => {
    const authorize = vi.fn(({ request }: { request: Request }) => request.headers.get("x-role") === "admin")
    const denied = await run({ mode: "open", authorize })
    expect(denied.handler).not.toHaveBeenCalled()
    await expect(rejection(denied.result)).resolves.toMatchObject({ code: "CONSOLE_ACCESS_DENIED", status: 403 })

    const allowed = await run({ mode: "open", authorize }, event({ "x-role": "admin" }))
    expect(allowed.result).toEqual({ mode: "open", sections: "all" })
    expect(authorize).toHaveBeenLastCalledWith({ request: expect.any(Request) })

    const custom = await run({ mode: "open", authorize: () => new Response("Sign in at the host.", { status: 401 }) })
    expect(custom.handler).not.toHaveBeenCalled()
    expect(custom.result).toBeInstanceOf(Response)
    await expect(Response.prototype.text.call(custom.result)).resolves.toBe("Sign in at the host.")

    const defined = await run({ mode: "open", authorize: defineConsoleAuthorize(() => true) })
    expect(defined.result).toEqual({ mode: "open", sections: "all" })
  })

  it("takes only signed calls in token mode", async () => {
    const signer = await signedConsoleAccess()
    try {
      const unsigned = await run({ mode: "token" }, requestEvent(new Request("https://app.example.com/_vitehub/rpc", { body: "{}", method: "POST" })))
      expect(unsigned.handler).not.toHaveBeenCalled()
      await expect(rejection(unsigned.result)).resolves.toMatchObject({ code: "CONSOLE_SIGNATURE_MISSING", status: 401 })
      // A cookie or a bearer token never counts.
      const bearer = await run({ mode: "token" }, requestEvent(new Request("https://app.example.com/_vitehub/rpc", { body: "{}", headers: { authorization: "Bearer token", cookie: "session=1" }, method: "POST" })))
      await expect(rejection(bearer.result)).resolves.toMatchObject({ status: 401 })
      const signed = await run({ mode: "token" }, requestEvent(await signer.sign(new Request("https://app.example.com/_vitehub/rpc", { body: "{}", method: "POST" }), { id: "ada" })))
      expect(signed.result).toMatchObject({ mode: "token", sections: "all", user: { id: "ada" }, via: "console" })
    }
    finally {
      signer.restore()
    }
  })

  it("rejects invalid policies", () => {
    expect(() => installConsoleAccess(JSON.parse('{"mode":"public"}'))).toThrow("known access mode")
    expect(() => installConsoleAccess({ mode: "open", authorize: JSON.parse('"server/authorize.ts"') })).toThrow("default-export a function")
    expect(() => defineConsoleAuthorize(JSON.parse("true"))).toThrow("requires a function")
  })
})

describe("Console access grants", () => {
  it("rejects a dynamic route when its section cannot be resolved", async () => {
    installConsoleAccess({ mode: "open" })
    const handler = vi.fn(() => "secret")
    const route = withConsoleAccess(handler, { section: () => undefined })
    const result = await route(event())
    expect(result).toBeInstanceOf(Response)
    await expect(rejection(result)).resolves.toMatchObject({ code: "CONSOLE_ACCESS_DENIED", status: 403 })
    expect(handler).not.toHaveBeenCalled()
  })

  it("rejects a forged access for an internal Console event", () => {
    const forged: ConsoleAccess = Object.freeze({ mode: "local", sections: "all" })
    expect(() => bindConsoleAccess(forged, event())).toThrow("not created by the access check")
  })

  it("does not run RPC operations with a forged access", async () => {
    installConsoleSections("/console-access", ["agents"])
    const forged: ConsoleAccess = Object.freeze({ mode: "local", sections: "all" })
    const response = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc", {
      body: operationRpcBody("sections.list", {}),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }), { access: forged })
    expect(response.status).toBe(403)
    await expect(operationRpcResponseResult(response)).resolves.toMatchObject({ ok: false, status: 403 })
  })

  it("reuses the checked access for an internal event once", async () => {
    const check = vi.fn(() => true)
    installConsoleAccess({ mode: "open", authorize: check })
    const inner = vi.fn((_event: ConsoleRequestEvent, access: ConsoleAccess) => access)
    const outer = withConsoleAccess(async (_event: ConsoleRequestEvent, access: ConsoleAccess) => {
      const internal = bindConsoleAccess(access, consoleEvent({ url: "http://vitehub.local/" }))
      expect(() => bindConsoleAccess(access, internal)).toThrow("already bound")
      return withConsoleAccess(inner, { anySection: true })(internal)
    }, { anySection: true })
    await expect(outer(event())).resolves.toEqual({ mode: "open", sections: "all" })
    expect(check).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(1)
  })
})

describe("read-only section access", () => {
  const readOnly: ConsoleAuthorize = () => ({ sections: ["agents:read"] })

  function rpc(operation: string, input: unknown = {}) {
    return handleGuardedRpcRequest(new Request("http://vitehub.local/_vitehub/rpc", {
      body: operationRpcBody(operation, input),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }))
  }

  it("shows the section but refuses a write route of it", async () => {
    installConsoleAccess({ mode: "open", authorize: readOnly })
    const read = vi.fn(() => "data")
    const write = vi.fn(() => "changed")
    expect(await withConsoleAccess(read, { section: "agents" })(event())).toBe("data")
    await expect(rejection(await withConsoleAccess(write, { section: "agents", write: true })(event()))).resolves.toMatchObject({ code: "CONSOLE_ACCESS_DENIED", status: 403 })
    expect(write).not.toHaveBeenCalled()
    await expect(rejection(await withConsoleAccess(read, { section: "usage" })(event()))).resolves.toMatchObject({ status: 403 })
    // The full grant wins over the read-only one.
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["agents:read", "agents"] }) })
    expect(await withConsoleAccess(write, { section: "agents", write: true })(event())).toBe("changed")
  })

  it("keeps the reads of the mixed document and media actions for a read-only grant", () => {
    const registry = consoleOperationRegistry()
    const documents = registry.get("documents.action")!
    const media = registry.get("media.action")!
    expect(documents.readOnlyWhen?.({ action: "list", section: "content" } as never)).toBe(true)
    expect(documents.readOnlyWhen?.({ action: "save", section: "content" } as never)).toBe(false)
    expect(media.readOnlyWhen?.({ action: "usage", section: "content" } as never)).toBe(true)
    expect(media.readOnlyWhen?.({ action: "remove", section: "content" } as never)).toBe(false)
  })

  it("runs reads over the RPC and refuses writes", async () => {
    installConsoleAccess({ mode: "open", authorize: readOnly })
    installConsoleSections("/console-read-only", ["agents"])
    expect((await rpc("sections.list")).status).toBe(200)
    expect((await rpc("invocations.list")).status).not.toBe(403)
    const refused = await rpc("invocations.cancel", { id: "run-1" })
    expect(refused.status).toBe(403)
    await expect(operationRpcResponseResult(refused)).resolves.toMatchObject({ message: expect.stringContaining("read-only"), ok: false })
  })
})

describe("generated Console access", () => {
  async function generatedPlugin(options: Parameters<typeof consoleVitePlugin>[0], command: "build" | "serve", config: { base?: string, nitro?: { handlers: Array<{ handler: string, middleware?: boolean, route: string }> } } = {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-access-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ sections: ["agents"], ...options })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a Console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      await Reflect.apply(configHandler, {}, [Object.assign(config, { root }), { command, mode: command === "build" ? "production" : "development" }])
      return await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  it("installs the local policy for the development shorthand", async () => {
    await expect(generatedPlugin({}, "serve")).resolves.toContain('installConsoleAccess({ mode: "local" })')
  })

  it("installs signed access for console: true", async () => {
    const plugin = await generatedPlugin({ console: {} }, "build")
    expect(plugin).toContain('installConsoleAccess({ mode: "token" })')
  })

  it.each([["/", "/_vitehub/rpc"], ["/portal/", "/portal/_vitehub/rpc"]])("marks only the Console RPC route below %s for app Auth access routes to leave to it", async (base, route) => {
    const auth: ResolvedAuthViteConfig = {
      access: { routes: [{ route: "/**" }] },
      basePath: "/api/auth",
      database: { mode: "default" },
      definition: { handler: "/server/auth.ts", name: "default", source: "server-auth" },
      rootDir: "/",
      route: "/api/auth",
      secondaryStorage: false,
      tables: false,
    }
    const config: { base: string, nitro: { handlers: Array<{ handler: string, meta?: Record<string, unknown>, middleware?: boolean, route: string }> } } = { base, nitro: { handlers: [] } }
    const plugin = await generatedPlugin({ console: {}, resolveAuthConfig: () => auth }, "build", config)
    // The exception follows the route that Nitro dispatches to, not a path, so the generated plugin names none.
    expect(plugin).not.toContain("vite-hub/auth/runtime/server")
    const { authAccessHandlerMeta } = await import("@vite-hub/auth/runtime/server")
    expect(config.nitro.handlers.filter(handler => handler.meta)).toEqual([expect.objectContaining({ route, meta: { ...authAccessHandlerMeta } })])
  })

  it("serves development operations with Setup-only navigation and no app-served pages", async () => {
    const assets = [{ baseURL: "/public", dir: "/user-owned-assets" }]
    const config = { base: "/portal/", nitro: { handlers: [], publicAssets: assets } }

    await expect(generatedPlugin({ rpcOnly: true }, "serve", config)).resolves.toContain('installConsoleAccess({ mode: "local" })')

    expect(config.nitro.handlers).toContainEqual(expect.objectContaining({ route: "/portal/_vitehub/rpc" }))
    expect(config.nitro.handlers).not.toContainEqual(expect.objectContaining({ handler: expect.stringMatching(/server\/(?:page\.get|sign-in|client\.get)\.js$/) }))
    expect(config.nitro.publicAssets).toEqual(assets)
  })

  it.each(["/", "/portal/"])("registers only the RPC and the page tools session, and no Console page, client, MCP, or assets, below %s", async (base) => {
    const mount = base.replace(/\/$/, "")
    const config: { base: string, nitro: { handlers: Array<{ handler: string, middleware?: boolean, route: string }>, publicAssets?: Array<{ baseURL?: string }> } } = { base, nitro: { handlers: [] } }
    await generatedPlugin({ console: {} }, "build", config)

    const routes = config.nitro.handlers.map(handler => handler.route)
    expect(routes).toEqual([`${mount}/_vitehub/rpc`, `${mount}/_vitehub/page/session`])
    for (const removed of ["/_vitehub", "/_vitehub/**", "/_vitehub/api/client.js", "/_vitehub/api/status", "/_vitehub/api/logs", "/_vitehub/api/usage", "/_vitehub/sign-in"]) {
      expect(routes, removed).not.toContain(`${mount}${removed}`)
    }
    expect(config.nitro.handlers).not.toContainEqual(expect.objectContaining({ handler: expect.stringMatching(/server\/(?:page\.get|client\.get)\.js$/) }))
    expect(config.nitro.publicAssets?.map(asset => asset.baseURL)).not.toContain(`${mount}/_vitehub/assets`)
  })

  it("imports console.authorize for open access", async () => {
    const plugin = await generatedPlugin({ console: { auth: false, authorize: hostManagedAuthorize } }, "serve")
    expect(plugin).toContain(`import vitehubConsoleAuthorize from ${JSON.stringify(pathToFileURL(hostManagedAuthorize).href)}`)
    expect(plugin).toContain('installConsoleAccess({ mode: "open", authorize: vitehubConsoleAuthorize })')
    await expect(generatedPlugin({ console: { auth: false, authorize: "missing-authorize.ts" } }, "serve"))
      .rejects.toThrow("console.authorize file does not exist")
  })

})

describe("Realtime rooms from Console access", () => {
  it.each(["comments:read", "comments"] as const)("keeps read and write section grants distinct: %s", async (section) => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: [section] }) })
    const access = consoleRealtimeAccess("comments")
    const request = event()
    await expect(access.authorize({ event: request })).resolves.toBe(true)
    await expect(access.authorize({ event: request, kind: "write" })).resolves.toBe(section === "comments")
  })

  it("names the person that the Console signed and gates rooms by section access", async () => {
    const signer = await signedConsoleAccess()
    try {
      installConsoleAccess({ mode: "token", authorize: ({ user }) => (user ? { sections: ["content"] } : { sections: ["kv"] }) })
      const signedEvent = async (user?: { id: string, name: string, email: string }) => requestEvent(await signer.sign(new Request("https://app.example.com/_vitehub/rpc", { body: "{}", method: "POST" }), user))
      const content = consoleRealtimeAccess("content")
      const ana = await signedEvent({ email: "ana@vitehub.dev", id: "ana", name: "Ana" })
      await expect(content.identify({ event: ana })).resolves.toEqual({ email: "ana@vitehub.dev", id: "ana", name: "Ana" })
      await expect(content.authorize({ event: ana })).resolves.toBe(true)
      await expect(content.user({ event: ana })).resolves.toMatchObject({ id: "ana" })
      // Without the section, a room has no person and no access.
      const cli = await signedEvent()
      await expect(content.identify({ event: cli })).resolves.toBeNull()
      await expect(content.authorize({ event: cli })).resolves.toBe(false)
      await expect(content.user({ event: cli })).resolves.toBeNull()
    }
    finally {
      signer.restore()
    }
  })

  it("makes each connection of an open Console a guest", async () => {
    installConsoleAccess({ mode: "open" })
    const open = consoleRealtimeAccess("content")
    await expect(open.identify({ event: event() })).resolves.toMatchObject({ id: expect.stringMatching(/^guest-/), name: "Guest" })
    await expect(open.user({ event: event() })).resolves.toBeNull()
  })

  it("denies a request that the access policy rejects", async () => {
    const signer = await signedConsoleAccess()
    try {
      await expect(consoleRealtimeAccess("content").identify({ event: event() })).resolves.toBeNull()
      await expect(consoleRealtimeAccess("content").identify({ event: "not an event" })).resolves.toBeNull()
    }
    finally {
      signer.restore()
    }
  })
})
