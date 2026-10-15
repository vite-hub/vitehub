import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { DatabaseSync } from "node:sqlite"

import { defineAuth } from "@vite-hub/auth"
import { handleAuthRequest, withAuthorization } from "@vite-hub/auth/server"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createConsoleAuthDefinition, defineConsoleAuth, defineConsoleAuthorize, prepareConsoleAuth } from "../src/console/auth.ts"
import { consoleRpcHeader, consoleRpcMethods } from "../src/console/runtime/rpc.ts"
import { createConnectionsHandler } from "@vite-hub/connections/http"
import { createConnectionsRuntime } from "@vite-hub/connections/server"

import { bindConsoleAccess, consoleConnectionsActor, consoleOpenAccessWarning, consoleRouteScope, installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import { consoleRpcOperationSection, handleConsoleRpcRequest } from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { assertConsoleAccess, consoleVitePlugin, resolveConsoleOptions } from "../src/console/vite.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

import type { ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { ConsoleAccess, ConsoleAccessPolicy } from "../src/console/runtime/server/access.ts"
import { consoleRequestURL, type ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

const policyKey = Symbol.for("vitehub.console.access")
const serverRoot = fileURLToPath(new URL("../src/console/runtime/server/", import.meta.url))
// The page shell and the empty client script carry no project data. Static assets are public in the same way.
const shellRoutes = new Set(["client.get.ts", "page.get.ts"])
// Routes that every Console user may call. The RPC transport checks the section of each operation itself.
const anySectionRoutes = new Set(["rpc.ts", "sections.get.ts"])

function event(headers: Record<string, string> = {}): ConsoleRequestEvent {
  return { method: "GET", req: new Request("http://vitehub.local/api/_vitehub/console/data", { headers }) }
}

async function run(policy: ConsoleAccessPolicy | undefined, request = event()) {
  if (policy) installConsoleAccess(policy)
  else Reflect.deleteProperty(globalThis, policyKey)
  const handler = vi.fn((_event: ConsoleRequestEvent, access: ConsoleAccess) => access)
  const result = await withConsoleAccess(handler, { section: "kv" })(request)
  return { handler, result }
}

async function rejection(result: unknown): Promise<{ message: string, status: number }> {
  if (!(result instanceof Response)) throw new TypeError("Expected a rejection Response.")
  const body: unknown = await result.json()
  return { message: body instanceof Object && "message" in body ? String(body.message) : "", status: result.status }
}

afterEach(() => {
  vi.unstubAllEnvs()
  Reflect.deleteProperty(globalThis, policyKey)
})

describe("Console data route contract", () => {
  async function guardedRoutes(): Promise<Array<{ file: string, handler: unknown, route: (event: ConsoleRequestEvent) => Promise<unknown> }>> {
    const files = (await readdir(serverRoot)).filter(file => file.endsWith(".ts")).sort()
    const routes: Array<{ file: string, handler: unknown, route: (event: ConsoleRequestEvent) => Promise<unknown> }> = []
    for (const file of files) {
      if (!/^export default /m.test(await readFile(join(serverRoot, file), "utf8")) || shellRoutes.has(file)) continue
      const route: unknown = (await import(join(serverRoot, file))).default
      if (!(route instanceof Function)) throw new TypeError(`${file} must default-export a route handler.`)
      routes.push({ file, handler: route, route: event => Promise.resolve(Reflect.apply(route, undefined, [event])) })
    }
    return routes
  }

  it("guards every Console server route with withConsoleAccess()", async () => {
    const routes = await guardedRoutes()
    expect(routes.map(route => route.file)).toContain("invocation-workspace.get.ts")
    expect(routes.map(route => route.file)).toContain("rpc.ts")

    for (const { file, route } of routes) {
      Reflect.deleteProperty(globalThis, policyKey)
      const result: unknown = await route(event())
      expect(result, `${file} must call withConsoleAccess() before it reads data`).toBeInstanceOf(Response)
      await expect(rejection(result), file).resolves.toMatchObject({ message: expect.stringContaining("Console access is not configured"), status: 500 })
    }
  })

  it("declares the Console section of every server route", async () => {
    for (const { file, handler } of await guardedRoutes()) {
      const scope = consoleRouteScope(handler)
      expect(scope, `${file} must pass { section } or { anySection: true } to withConsoleAccess()`).toBeDefined()
      expect(scope && "anySection" in scope, `${file} must declare its section`).toBe(anySectionRoutes.has(file))
    }
  })

  it("rejects every section route outside the allowed sections", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["not-a-route-section"] }) })
    for (const { file, route } of await guardedRoutes()) {
      if (anySectionRoutes.has(file)) continue
      await expect(rejection(await route(event())), file).resolves.toMatchObject({ status: 403 })
    }
  })

  it("rejects a route without a declared section", () => {
    // @ts-expect-error Every guarded route declares its Console section.
    expect(() => withConsoleAccess(() => "data")).toThrow("requires { section } or { anySection: true }")
    expect(() => withConsoleAccess(() => "data", JSON.parse('{"section":""}'))).toThrow("requires { section } or { anySection: true }")
  })

  it("declares the Console section of every RPC operation", () => {
    for (const method of Object.values(consoleRpcMethods)) {
      const input = method === consoleRpcMethods.definitions ? { query: { section: "workflows" } } : {}
      expect(consoleRpcOperationSection(method, input), method).not.toBeUndefined()
    }
    expect(consoleRpcOperationSection(consoleRpcMethods.sections)).toBe(false)
    expect(consoleRpcOperationSection(consoleRpcMethods.definitions, { query: { section: "workflows" } })).toBe("workflows")
  })

  it("guards the Schedule run RPC operation", async () => {
    const { consoleScheduleRunHandler } = await import("../src/console/runtime/server/schedule-run.ts")
    await expect(rejection(await consoleScheduleRunHandler(event()))).resolves.toMatchObject({ status: 500 })
  })
})

describe("Console access policies", () => {
  it("fails closed when no policy is installed", async () => {
    const { handler, result } = await run(undefined)
    expect(handler).not.toHaveBeenCalled()
    await expect(rejection(result)).resolves.toMatchObject({ status: 500 })
  })

  it("keeps auth: false open in every environment and warns once in production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const warned = Symbol.for("vitehub.console.access.open-warning")
    try {
      const allowed = await run({ mode: "open" })
      expect(allowed.result).toEqual({ mode: "open", sections: "all" })
      expect(Object.isFrozen(allowed.result)).toBe(true)
      expect(warn).not.toHaveBeenCalled()

      vi.stubEnv("NODE_ENV", "production")
      Reflect.deleteProperty(globalThis, warned)
      const production = await run({ mode: "open" })
      expect(production.result).toEqual({ mode: "open", sections: "all" })
      installConsoleAccess({ mode: "open" })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(consoleOpenAccessWarning)

      Reflect.deleteProperty(globalThis, warned)
      installConsoleAccess({ mode: "open", authorize: () => true })
      expect(warn).toHaveBeenCalledTimes(1)
    }
    finally {
      warn.mockRestore()
      Reflect.deleteProperty(globalThis, warned)
    }
  })

  it("calls console.authorize after the access mode check", async () => {
    const authorize = vi.fn(({ request }: { request: Request }) => request.headers.get("x-role") === "admin")
    const denied = await run({ mode: "open", authorize })
    expect(denied.handler).not.toHaveBeenCalled()
    await expect(rejection(denied.result)).resolves.toMatchObject({ status: 403 })

    const allowed = await run({ mode: "open", authorize }, event({ "x-role": "admin" }))
    expect(allowed.result).toEqual({ mode: "open", sections: "all" })
    expect(authorize).toHaveBeenLastCalledWith({ request: expect.any(Request) })

    const custom = await run({ mode: "open", authorize: () => new Response("Sign in at the host.", { status: 401 }) })
    expect(custom.handler).not.toHaveBeenCalled()
    expect(custom.result).toBeInstanceOf(Response)
    await expect(Response.prototype.text.call(custom.result)).resolves.toBe("Sign in at the host.")

    const defined = await run({ mode: "open", authorize: defineConsoleAuthorize(() => true) })
    expect(defined.result).toEqual({ mode: "open", sections: "all" })

    const notReached = vi.fn(() => true)
    const unauthenticated = await run({ mode: "auth", check: async () => new Response(null, { status: 401 }), authorize: notReached })
    expect(unauthenticated.result).toMatchObject({ status: 401 })
    expect(notReached).not.toHaveBeenCalled()
  })

  it("gives console.authorize the signed-in user", async () => {
    const authorize = vi.fn(({ user }: { user?: { id: string } }) => user?.id === "ada")
    const user = vi.fn(async () => ({ id: "ada", role: "editor" }))
    const allowed = await run({ mode: "auth", check: async () => undefined, user, authorize })
    expect(authorize).toHaveBeenCalledWith({ request: expect.any(Request), user: { id: "ada", role: "editor" } })
    expect(allowed.result).toEqual({ mode: "auth", sections: "all", user: { id: "ada", role: "editor" } })

    // Without console.authorize, a data route does not read the user.
    user.mockClear()
    await run({ mode: "auth", check: async () => undefined, user })
    expect(user).not.toHaveBeenCalled()
  })

  it("scopes the access to the sections that console.authorize returns", async () => {
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv", "content", "kv"] }) })
    const kv = vi.fn(() => "kv data")
    const blob = vi.fn(() => "blob data")
    await expect(withConsoleAccess(kv, { section: "kv" })(event())).resolves.toBe("kv data")
    const outside = await withConsoleAccess(blob, { section: "blob" })(event())
    expect(blob).not.toHaveBeenCalled()
    await expect(rejection(outside)).resolves.toMatchObject({ status: 403 })
    await expect(withConsoleAccess((_event, access) => access, { anySection: true })(event())).resolves.toEqual({ mode: "open", sections: ["kv", "content"] })

    // A section read from the request must be in the scope too. An unknown section needs access to every section.
    const fromQuery = withConsoleAccess(() => "definitions", { section: request => consoleRequestURL(request).searchParams.get("section") ?? undefined })
    const query = (section?: string): ConsoleRequestEvent => ({ method: "GET", req: new Request(`http://vitehub.local/api/_vitehub/console/definitions${section ? `?section=${section}` : ""}`) })
    await expect(fromQuery(query("content"))).resolves.toBe("definitions")
    await expect(rejection(await fromQuery(query("workflows")))).resolves.toMatchObject({ status: 403 })
    await expect(rejection(await fromQuery(query()))).resolves.toMatchObject({ status: 403 })
  })

  it.each([
    { name: "an empty section list", result: { sections: [] }, status: 403 },
    { name: "a non-string section", result: { sections: [1] }, status: 500 },
    { name: "nothing", result: null, status: 500 },
    { name: "a string", result: "admin", status: 500 },
  ])("fails closed when console.authorize returns $name", async ({ result, status }) => {
    const denied = await run({ mode: "open", authorize: () => JSON.parse(JSON.stringify(result)) })
    expect(denied.handler).not.toHaveBeenCalled()
    await expect(rejection(denied.result)).resolves.toMatchObject({ status })
  })

  it("checks the Auth Session and fails closed without an Auth Definition", async () => {
    const missing = await run({ mode: "auth" })
    expect(missing.handler).not.toHaveBeenCalled()
    await expect(rejection(missing.result)).resolves.toMatchObject({ message: expect.stringContaining("Auth Definition"), status: 500 })

    const unauthorized = await run({ mode: "auth", check: async () => Response.json({ error: "Unauthorized." }, { status: 401 }) })
    expect(unauthorized.handler).not.toHaveBeenCalled()
    expect(unauthorized.result).toMatchObject({ status: 401 })

    const check = vi.fn(async () => undefined)
    const request = event()
    const allowed = await run({ mode: "cloudflare-access", check }, request)
    expect(check).toHaveBeenCalledWith(request)
    expect(allowed.result).toEqual({ mode: "cloudflare-access", sections: "all" })
  })

  it("checks a real Console Auth Session with withAuthorization()", async () => {
    const database = new DatabaseSync(":memory:")
    try {
      const input = defineConsoleAuth({
        auth: defineAuth(() => ({
          baseURL: "https://example.com",
          database,
          emailAndPassword: { enabled: true },
          secret: "test-secret-at-least-32-bytes-long",
        })),
        authorize: ({ user }) => user.email === "allowed@example.com",
        signIn: { provider: "github" },
      })
      const definition = createConsoleAuthDefinition(input)
      const signUp = async (email: string): Promise<string> => {
        const request = new Request("https://example.com/api/_vitehub/console/auth/sign-up/email", {
          body: JSON.stringify({ email, name: email, password: "passwordpassword" }),
          headers: { "content-type": "application/json", origin: "https://example.com" },
          method: "POST",
        })
        await prepareConsoleAuth(input, definition, request)
        const response = await handleAuthRequest(definition, request)
        expect(response.status).toBe(200)
        return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
      }
      // This is the check that the generated Console Auth middleware module exports.
      const authorizeConsole = withAuthorization(input.authorize, () => undefined, definition)
      installConsoleAccess({
        mode: "auth",
        check: async request => request.req instanceof Request ? authorizeConsole(request.req) : new Response(null, { status: 400 }),
      })
      const route = withConsoleAccess(() => "workspace file", { section: "workspaces" })
      const call = (cookie?: string) => route({
        method: "GET",
        req: new Request("https://example.com/_vitehub/rpc/__call", { headers: cookie ? { cookie } : {} }),
      })

      const denied = await signUp("denied@example.com")
      const allowed = await signUp("allowed@example.com")
      expect(await call()).toMatchObject({ status: 401 })
      expect(await call(denied)).toMatchObject({ status: 403 })
      await expect(call(allowed)).resolves.toBe("workspace file")
    }
    finally {
      database.close()
    }
  })

  it("rejects invalid policies", () => {
    expect(() => installConsoleAccess(JSON.parse('{"mode":"public"}'))).toThrow("known access mode")
    expect(() => installConsoleAccess({ mode: "open", authorize: JSON.parse('"server/authorize.ts"') })).toThrow("default-export a function")
    expect(() => defineConsoleAuthorize(JSON.parse("true"))).toThrow("requires a function")
  })
})

describe("Console access grants", () => {
  it("rejects a forged access for an internal Console event", () => {
    const forged: ConsoleAccess = Object.freeze({ mode: "open", sections: "all" })
    expect(() => bindConsoleAccess(forged, event())).toThrow("Forbidden")
  })

  it("does not run RPC operations with a forged access", async () => {
    installConsoleSections("/console-access", ["agents"])
    const forged: ConsoleAccess = Object.freeze({ mode: "open", sections: "all" })
    const response = await handleConsoleRpcRequest(new Request("http://vitehub.local/_vitehub/rpc/__call", {
      body: JSON.stringify({ input: {}, method: consoleRpcMethods.sections }),
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      method: "POST",
    }), { access: forged })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ ok: false, status: 403 })
  })

  it("reuses the checked access for an internal event once", async () => {
    const check = vi.fn(async () => undefined)
    installConsoleAccess({ mode: "auth", check })
    const inner = vi.fn((_event: ConsoleRequestEvent, access: ConsoleAccess) => access)
    const outer = withConsoleAccess(async (_event: ConsoleRequestEvent, access: ConsoleAccess) => {
      const internal = bindConsoleAccess(access, { method: "GET" })
      expect(() => bindConsoleAccess(access, internal)).toThrow("already bound")
      return withConsoleAccess(inner, { section: "kv" })(internal)
    }, { anySection: true })
    await expect(outer(event())).resolves.toEqual({ mode: "auth", sections: "all" })
    expect(check).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(1)
  })
})

describe("Connections manager from Console access", () => {
  function connectionsEvent(): ConsoleRequestEvent {
    return { method: "POST", req: new Request("http://vitehub.local/_vitehub/connections", { headers: { "content-type": "application/json", origin: "http://vitehub.local" }, method: "POST", body: JSON.stringify({ action: "list" }) }) }
  }

  it.each([
    { name: "open with authorize", policy: { mode: "open", authorize: () => true }, actor: "user:open" },
    { name: "open denied by authorize", policy: { mode: "open", authorize: () => false }, actor: undefined },
    { name: "open without the Connections section", policy: { mode: "open", authorize: () => ({ sections: ["kv"] }) }, actor: undefined },
    { name: "open with the Connections section", policy: { mode: "open", authorize: () => ({ sections: ["connections"] }) }, actor: "user:open" },
    { name: "open", policy: { mode: "open" }, actor: "user:open" },
    { name: "auth with a session", policy: { mode: "auth", check: async () => undefined, user: async () => ({ id: "ada" }) }, actor: "user:ada" },
    { name: "auth without a session", policy: { mode: "auth", check: async () => undefined, user: async () => undefined }, actor: undefined },
    { name: "auth without a user reader", policy: { mode: "auth", check: async () => undefined }, actor: undefined },
    { name: "auth rejected by the policy", policy: { mode: "auth", check: async () => new Response(null, { status: 403 }), user: async () => ({ id: "ada" }) }, actor: undefined },
    { name: "cloudflare-access", policy: { mode: "cloudflare-access", check: async () => undefined }, actor: "user:cloudflare-access" },
  ] satisfies Array<{ name: string, policy: ConsoleAccessPolicy, actor: string | undefined }>)("uses the Console policy: $name", async ({ policy, actor }) => {
    installConsoleAccess(policy)
    await expect(consoleConnectionsActor(connectionsEvent())).resolves.toBe(actor)
  })

  it("denies Connections without an installed policy", async () => {
    await expect(consoleConnectionsActor(connectionsEvent())).resolves.toBeUndefined()
  })

  it("runs Connections routes only after console.authorize", async () => {
    const authorize = vi.fn(({ request }: { request: Request }) => request.headers.get("x-admin") === "1")
    installConsoleAccess({ mode: "open", authorize })
    // No Connection Definitions, so `list` never opens the store.
    const runtime = vi.fn(() => createConnectionsRuntime({ definitions: {}, store: () => { throw new Error("The store is not used.") } }))
    const call = (headers: Record<string, string>) => {
      const request = new Request("http://vitehub.local/_vitehub/connections", { body: JSON.stringify({ action: "list" }), headers: { "content-type": "application/json", origin: "http://vitehub.local", ...headers }, method: "POST" })
      const requestEvent: ConsoleRequestEvent = { method: "POST", req: request }
      return createConnectionsHandler({ actor: () => consoleConnectionsActor(requestEvent), runtime })(request, requestEvent)
    }
    expect((await call({})).status).toBe(403)
    expect(runtime).not.toHaveBeenCalled()
    const allowed = await call({ "x-admin": "1" })
    expect(allowed.status).toBe(200)
    await expect(allowed.json()).resolves.toEqual({ connections: [] })
    expect(authorize).toHaveBeenCalledTimes(2)
  })
})

describe("generated Console access", () => {
  async function generatedPlugin(options: Partial<Parameters<typeof consoleVitePlugin>[0]> & Pick<Parameters<typeof consoleVitePlugin>[0], "console">, command: "build" | "serve"): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-access-"))
    try {
      await writeFile(join(root, "package.json"), "{}\n")
      const plugin = consoleVitePlugin({ preset: "node", sections: ["agents"], ...options })
      const configHook = plugin.config
      if (!configHook) throw new TypeError("Expected a Console config hook.")
      const configHandler = "handler" in configHook ? configHook.handler : configHook
      await Reflect.apply(configHandler, {}, [{ root }, { command, mode: command === "build" ? "production" : "development" }])
      return await readFile(join(root, ".vitehub/nitro/console/plugin.mjs"), "utf8")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  const appAuth = (routes: ResolvedAuthViteConfig["access"]["routes"]): ResolvedAuthViteConfig => ({
    access: { routes },
    basePath: "/api/auth",
    database: { mode: "default" },
    definition: { handler: "/server/auth.ts", name: "default", source: "server-auth" },
    rootDir: "/",
    route: "/api/auth",
    secondaryStorage: false,
  })

  it("requires an explicit Console access choice in every environment", () => {
    expect(() => resolveConsoleOptions(true)).toThrow('console: { auth: false } for no sign-in, or console: { auth: "app" }')
    expect(() => resolveConsoleOptions({})).toThrow("console.auth is required")
    expect(() => resolveConsoleOptions(JSON.parse('{"access":"auth"}'))).toThrow("console.auth is required")
    expect(() => resolveConsoleOptions({ auth: "public" })).toThrow('console.auth must be false, "app", or a Console Auth config object')
    expect(resolveConsoleOptions(undefined)).toBeUndefined()
    expect(resolveConsoleOptions(false)).toBeUndefined()
    expect(resolveConsoleOptions({ auth: false })).toEqual({ auth: false })
  })

  it.each(["serve", "build"] as const)("installs the open policy for auth: false (%s)", async (command) => {
    await expect(generatedPlugin({ console: { auth: false } }, command)).resolves.toContain('installConsoleAccess({ mode: "open" })')
  })

  it("imports console.authorize with auth: false", async () => {
    const plugin = await generatedPlugin({ console: { auth: false, authorize: hostManagedAuthorize } }, "build")
    expect(plugin).toContain(`import vitehubConsoleAuthorize from ${JSON.stringify(pathToFileURL(hostManagedAuthorize).href)}`)
    expect(plugin).toContain('installConsoleAccess({ mode: "open", authorize: vitehubConsoleAuthorize })')
  })

  it("rejects a missing console.authorize file", async () => {
    await expect(generatedPlugin({ console: { auth: false, authorize: "missing-authorize.ts" } }, "serve"))
      .rejects.toThrow("console.authorize file does not exist")
  })

  it("combines app Auth with console.authorize and reads the session user", async () => {
    const plugin = await generatedPlugin({
      console: { auth: "app", authorize: hostManagedAuthorize },
      resolveAuthConfig: () => appAuth([{ route: "/api/**" }]),
    }, "build")
    expect(plugin).toContain("check: event => {")
    expect(plugin).toContain("if (!matched.length) return vitehubRequireSession(event)")
    expect(plugin).toContain("const vitehubRequireSession = vitehubWithAuthorization(true, () => undefined)")
    expect(plugin).toContain("user: event => vitehubReadConsoleSessionUser(vitehubGetAuthForRequest(event.req, undefined, event), event.req)")
    expect(plugin).toContain("authorize: vitehubConsoleAuthorize")
  })

  it("checks the app Auth access routes that protect the Console", async () => {
    const plugin = await generatedPlugin({
      console: { auth: "app" },
      resolveAuthConfig: () => appAuth([
        { route: "/api/**" },
        { authorize: true, route: "/_vitehub/**" },
        { authorize: true, method: "GET", route: "/api/_vitehub/console/**" },
      ]),
    }, "build")
    expect(plugin).toContain('"authorize":true,"index":1,"route":"/_vitehub/**"')
    expect(plugin).toContain('"authorize":true,"index":2,"method":"GET","route":"/api/_vitehub/console/**"')
    expect(plugin).toContain('const matched = [{"authorize":true,"index":1,"route":"/_vitehub/**"},{"authorize":true,"index":2,"method":"GET","route":"/api/_vitehub/console/**"}]')
    expect(plugin).toContain('return path === base || path.startsWith(base + "/")')
  })

  it("accepts exact GET rules for the registered Console API endpoints", async () => {
    const plugin = await generatedPlugin({
      console: { auth: "app" },
      sections: ["agents", "usage"],
      resolveAuthConfig: () => appAuth([
        { authorize: true, route: "/_vitehub/**" },
        { authorize: true, method: "GET", route: "/api/_vitehub/console/status" },
        { authorize: true, method: "GET", route: "/api/_vitehub/console/usage" },
      ]),
    }, "build")
    expect(plugin).toContain('"authorize":true,"index":1,"method":"GET","route":"/api/_vitehub/console/status"')
    expect(plugin).toContain('"authorize":true,"index":2,"method":"GET","route":"/api/_vitehub/console/usage"')
  })

  it.each([undefined, "/portal/"])("accepts exact status access with base %s when Usage is not registered", (base) => {
    const prefix = base?.replace(/\/$/, "") ?? ""
    expect(() => assertConsoleAccess({ auth: "app" }, {
      auth: appAuth([
        { authorize: true, route: `${prefix}/_vitehub/**` },
        { authorize: true, method: "GET", route: `${prefix}/api/_vitehub/console/status` },
      ]),
      base,
      sections: ["agents"],
    })).not.toThrow()
  })

  it.each([
    { authorize: true, method: "POST", route: "/api/_vitehub/console/status" } as const,
    { method: "GET", route: "/api/_vitehub/console/status" } as const,
    { authorize: true, method: "GET", route: "/api/_vitehub/console/status/child" } as const,
  ])("rejects a rule that does not authorize GET status: %j", (route) => {
    expect(() => assertConsoleAccess({ auth: "app" }, {
      auth: appAuth([{ authorize: true, route: "/_vitehub/**" }, route]),
    })).toThrow("/api/_vitehub/console/status")
  })

  it("does not need Auth access routes when console.authorize decides", () => {
    expect(() => assertConsoleAccess({ auth: "app", authorize: hostManagedAuthorize }, { auth: appAuth([]) })).not.toThrow()
    expect(() => assertConsoleAccess({ auth: "app", authorize: hostManagedAuthorize }, {})).toThrow("requires a discovered ViteHub Auth Definition")
  })

  it("requires separate Usage coverage when the Usage endpoint is registered", () => {
    expect(() => assertConsoleAccess({ auth: "app" }, {
      auth: appAuth([
        { authorize: true, route: "/_vitehub/**" },
        { authorize: true, method: "GET", route: "/api/_vitehub/console/status" },
      ]),
      sections: ["agents", "usage"],
    })).toThrow("/api/_vitehub/console/usage")
  })

  it("does not treat an exact Console shell rule as recursive protection", () => {
    expect(() => assertConsoleAccess({ auth: "app" }, {
      auth: appAuth([
        { authorize: true, route: "/_vitehub" },
        { authorize: true, method: "GET", route: "/api/_vitehub/console/**" },
      ]),
    })).toThrow("/_vitehub/**")
  })

  it.each(["serve", "build"] as const)("rejects app Auth without a discovered Auth Definition (%s)", async (command) => {
    await expect(generatedPlugin({ console: { auth: "app" } }, command)).rejects.toThrow("requires a discovered ViteHub Auth Definition")
  })
})
