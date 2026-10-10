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

import { bindConsoleAccess, consoleConnectionsActor, installConsoleAccess, withConsoleAccess } from "../src/console/runtime/server/access.ts"
import { handleConsoleRpcRequest } from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { assertConsoleProductionAccess, consoleVitePlugin } from "../src/console/vite.ts"
import { hostManagedAuthorize } from "./support/console-authorize.ts"

import type { ResolvedAuthViteConfig } from "@vite-hub/auth"
import type { ConsoleAccess, ConsoleAccessPolicy } from "../src/console/runtime/server/access.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

const policyKey = Symbol.for("vitehub.console.access")
const serverRoot = fileURLToPath(new URL("../src/console/runtime/server/", import.meta.url))
// The page shell and the empty client script carry no project data. Static assets are public in the same way.
const shellRoutes = new Set(["client.get.ts", "page.get.ts"])

function event(headers: Record<string, string> = {}): ConsoleRequestEvent {
  return { method: "GET", req: new Request("http://vitehub.local/api/_vitehub/console/data", { headers }) }
}

async function run(policy: ConsoleAccessPolicy | undefined, request = event()) {
  if (policy) installConsoleAccess(policy)
  else Reflect.deleteProperty(globalThis, policyKey)
  const handler = vi.fn((_event: ConsoleRequestEvent, access: ConsoleAccess) => access)
  const result = await withConsoleAccess(handler)(request)
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
  it("guards every Console server route with withConsoleAccess()", async () => {
    const files = (await readdir(serverRoot)).filter(file => file.endsWith(".ts")).sort()
    const routes: string[] = []
    for (const file of files) {
      if (!/^export default /m.test(await readFile(join(serverRoot, file), "utf8"))) continue
      routes.push(file)
    }
    expect(routes).toContain("invocation-workspace.get.ts")
    expect(routes).toContain("rpc.ts")

    for (const file of routes.filter(route => !shellRoutes.has(route))) {
      Reflect.deleteProperty(globalThis, policyKey)
      const route: unknown = (await import(join(serverRoot, file))).default
      if (!(route instanceof Function)) throw new TypeError(`${file} must default-export a route handler.`)
      const result: unknown = await route(event())
      expect(result, `${file} must call withConsoleAccess() before it reads data`).toBeInstanceOf(Response)
      await expect(rejection(result), file).resolves.toMatchObject({ message: expect.stringContaining("Console access is not configured"), status: 500 })
    }
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

  it("keeps the local development Console open and fails closed in production", async () => {
    const allowed = await run({ mode: "local" })
    expect(allowed.result).toEqual({ mode: "local" })
    expect(Object.isFrozen(allowed.result)).toBe(true)

    vi.stubEnv("NODE_ENV", "production")
    const denied = await run({ mode: "local" })
    expect(denied.handler).not.toHaveBeenCalled()
    await expect(rejection(denied.result)).resolves.toMatchObject({ message: expect.stringContaining("development-only"), status: 403 })
  })

  it("requires the host authorize function for host-managed exposure", async () => {
    const missing = await run({ mode: "host-managed" })
    expect(missing.handler).not.toHaveBeenCalled()
    await expect(rejection(missing.result)).resolves.toMatchObject({ message: expect.stringContaining("requires console.authorize"), status: 500 })

    const authorize = vi.fn(({ request }: { request: Request }) => request.headers.get("x-role") === "admin")
    const denied = await run({ mode: "host-managed", authorize })
    expect(denied.handler).not.toHaveBeenCalled()
    await expect(rejection(denied.result)).resolves.toMatchObject({ status: 403 })

    const allowed = await run({ mode: "host-managed", authorize }, event({ "x-role": "admin" }))
    expect(allowed.result).toEqual({ mode: "host-managed" })
    expect(authorize).toHaveBeenLastCalledWith({ request: expect.any(Request) })

    const custom = await run({ mode: "host-managed", authorize: () => new Response("Sign in at the host.", { status: 401 }) })
    expect(custom.handler).not.toHaveBeenCalled()
    expect(custom.result).toBeInstanceOf(Response)
    await expect(Response.prototype.text.call(custom.result)).resolves.toBe("Sign in at the host.")

    const defined = await run({ mode: "host-managed", authorize: defineConsoleAuthorize(() => true) })
    expect(defined.result).toEqual({ mode: "host-managed" })
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
    expect(allowed.result).toEqual({ mode: "cloudflare-access" })
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
      const route = withConsoleAccess(() => "workspace file")
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
    expect(() => installConsoleAccess({ mode: "host-managed", authorize: JSON.parse('"server/authorize.ts"') })).toThrow("default-export a function")
    expect(() => defineConsoleAuthorize(JSON.parse("true"))).toThrow("requires a function")
  })
})

describe("Console access grants", () => {
  it("rejects a forged access for an internal Console event", () => {
    const forged: ConsoleAccess = Object.freeze({ mode: "local" })
    expect(() => bindConsoleAccess(forged, event())).toThrow("Forbidden")
  })

  it("does not run RPC operations with a forged access", async () => {
    installConsoleSections("/console-access", ["agents"])
    const forged: ConsoleAccess = Object.freeze({ mode: "local" })
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
      return withConsoleAccess(inner)(internal)
    })
    await expect(outer(event())).resolves.toEqual({ mode: "auth" })
    expect(check).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledTimes(1)
  })
})

describe("Connections manager from Console access", () => {
  function connectionsEvent(): ConsoleRequestEvent {
    return { method: "POST", req: new Request("http://vitehub.local/_vitehub/connections", { headers: { "content-type": "application/json", origin: "http://vitehub.local" }, method: "POST", body: JSON.stringify({ action: "list" }) }) }
  }

  it.each([
    { name: "host-managed allows", policy: { mode: "host-managed", authorize: () => true }, actor: "user:host-managed" },
    { name: "host-managed denies", policy: { mode: "host-managed", authorize: () => false }, actor: undefined },
    { name: "host-managed without authorize", policy: { mode: "host-managed" }, actor: undefined },
    { name: "auth with a session", policy: { mode: "auth", check: async () => undefined }, session: "user:ada", actor: "user:ada" },
    { name: "auth without a session", policy: { mode: "auth", check: async () => undefined }, actor: undefined },
    { name: "auth rejected by the policy", policy: { mode: "auth", check: async () => new Response(null, { status: 403 }) }, session: "user:ada", actor: undefined },
    { name: "cloudflare-access", policy: { mode: "cloudflare-access", check: async () => undefined }, actor: "user:cloudflare-access" },
    { name: "local", policy: { mode: "local" }, actor: "user:local" },
  ] satisfies Array<{ name: string, policy: ConsoleAccessPolicy, session?: string, actor: string | undefined }>)("uses the Console policy: $name", async ({ policy, session, actor }) => {
    installConsoleAccess(policy)
    await expect(consoleConnectionsActor(connectionsEvent(), session ? async () => session : undefined)).resolves.toBe(actor)
  })

  it("denies the local Console policy in production and without an installed policy", async () => {
    vi.stubEnv("NODE_ENV", "production")
    installConsoleAccess({ mode: "local" })
    await expect(consoleConnectionsActor(connectionsEvent())).resolves.toBeUndefined()
    Reflect.deleteProperty(globalThis, policyKey)
    vi.unstubAllEnvs()
    await expect(consoleConnectionsActor(connectionsEvent())).resolves.toBeUndefined()
  })

  it("runs Connections routes only after the host-managed authorize function", async () => {
    const authorize = vi.fn(({ request }: { request: Request }) => request.headers.get("x-admin") === "1")
    installConsoleAccess({ mode: "host-managed", authorize })
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
  async function generatedPlugin(options: Parameters<typeof consoleVitePlugin>[0], command: "build" | "serve"): Promise<string> {
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

  it("installs the local policy for the development shorthand", async () => {
    await expect(generatedPlugin({}, "serve")).resolves.toContain('installConsoleAccess({ mode: "local" })')
  })

  it("imports console.authorize for host-managed exposure", async () => {
    const plugin = await generatedPlugin({ console: { authorize: hostManagedAuthorize, exposure: "host-managed" } }, "build")
    expect(plugin).toContain(`import vitehubConsoleAuthorize from ${JSON.stringify(pathToFileURL(hostManagedAuthorize).href)}`)
    expect(plugin).toContain('installConsoleAccess({ mode: "host-managed", authorize: vitehubConsoleAuthorize })')
  })

  it("fails closed without console.authorize for host-managed exposure", async () => {
    const development = await generatedPlugin({ console: JSON.parse('{"exposure":"host-managed"}') }, "serve")
    expect(development).toContain('installConsoleAccess({ mode: "host-managed" })')
    expect(() => assertConsoleProductionAccess(JSON.parse('{"exposure":"host-managed"}'), { development: false }))
      .toThrow("requires console.authorize")
    await expect(generatedPlugin({ console: { authorize: "missing-authorize.ts", exposure: "host-managed" } }, "serve"))
      .rejects.toThrow("console.authorize file does not exist")
  })

  it("checks the Primary Auth access routes that protect the Console", async () => {
    const plugin = await generatedPlugin({
      console: { access: "auth" },
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
      console: { access: "auth" },
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
    expect(() => assertConsoleProductionAccess({ access: "auth" }, {
      auth: appAuth([
        { authorize: true, route: `${prefix}/_vitehub/**` },
        { authorize: true, method: "GET", route: `${prefix}/api/_vitehub/console/status` },
      ]),
      base,
      development: false,
      sections: ["agents"],
    })).not.toThrow()
  })

  it.each([
    { authorize: true, method: "POST", route: "/api/_vitehub/console/status" } as const,
    { method: "GET", route: "/api/_vitehub/console/status" } as const,
    { authorize: true, method: "GET", route: "/api/_vitehub/console/status/child" } as const,
  ])("rejects a rule that does not authorize GET status: %j", (route) => {
    expect(() => assertConsoleProductionAccess({ access: "auth" }, {
      auth: appAuth([{ authorize: true, route: "/_vitehub/**" }, route]),
      development: false,
    })).toThrow("/api/_vitehub/console/status")
  })

  it("requires separate Usage coverage when the Usage endpoint is registered", () => {
    expect(() => assertConsoleProductionAccess({ access: "auth" }, {
      auth: appAuth([
        { authorize: true, route: "/_vitehub/**" },
        { authorize: true, method: "GET", route: "/api/_vitehub/console/status" },
      ]),
      development: false,
      sections: ["agents", "usage"],
    })).toThrow("/api/_vitehub/console/usage")
  })

  it("does not treat an exact Console shell rule as recursive protection", () => {
    expect(() => assertConsoleProductionAccess({ access: "auth" }, {
      auth: appAuth([
        { authorize: true, route: "/_vitehub" },
        { authorize: true, method: "GET", route: "/api/_vitehub/console/**" },
      ]),
      development: false,
    })).toThrow("/_vitehub/**")
  })

  it("fails closed for Auth access without a discovered Auth Definition", async () => {
    await expect(generatedPlugin({ console: { access: "auth" } }, "serve")).resolves.toContain('installConsoleAccess({ mode: "auth" })')
  })
})
