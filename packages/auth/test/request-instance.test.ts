import { H3 } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createAuthAccessHandler, handleAuthRequest, requireAuth, resetAuth, setAuthRuntimeEnvResolver, useAuth, withAuth, withAuthorization } from "../src/internal/server.ts"
import { requestEvent } from "./request-event.ts"

const provider = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  getSession: vi.fn(),
  handler: vi.fn(),
}))

vi.mock("better-auth", () => ({ betterAuth: provider.betterAuth }))

// The app's discovered Definition, which `useAuth(event)` reads. A callback resolves it again for each request.
vi.mock("#vitehub/auth/definition", async () => {
  const { defineAuth } = await import("../src/index.ts")
  return { default: defineAuth(({ requestOrigin }) => ({ appName: "ViteHub", baseURL: requestOrigin })) }
})

const session = { session: { id: "session" }, user: { id: "user" } }

function request(url: string): Request {
  return new Request(url, { headers: { cookie: "session=1" } })
}

describe("Auth request instances", () => {
  beforeEach(() => {
    resetAuth()
    provider.betterAuth.mockReset().mockImplementation(() => ({
      $context: Promise.resolve({}),
      api: { getSession: provider.getSession },
      handler: provider.handler,
    }))
    provider.getSession.mockReset().mockResolvedValue(session)
    provider.handler.mockReset().mockImplementation(async () => new Response("ok"))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetAuth()
  })

  it("reuses one instance for requests with equal resolved options", async () => {
    const definition = defineAuth({ appName: "ViteHub" })
    const guard = withAuth(() => "ok", definition)
    expect(await guard(request("https://app.example/one"))).toBe("ok")
    expect(await guard(requestEvent(request("https://app.example/two")))).toBe("ok")
    expect((await handleAuthRequest(definition, request("https://app.example/api/auth/ok"))).status).toBe(200)
    expect(provider.betterAuth).toHaveBeenCalledOnce()
  })

  it("reuses the instance of a callback that returns plain values", async () => {
    const definition = defineAuth(({ requestOrigin }) => ({ appName: "ViteHub", baseURL: requestOrigin, socialProviders: { github: { clientId: "id", clientSecret: "secret" } } }))
    const guard = withAuth(() => "ok", definition)
    await guard(request("https://app.example/one"))
    await guard(request("https://app.example/two"))
    expect(provider.betterAuth).toHaveBeenCalledOnce()
  })

  it("reuses the instance of a callback that calls authDatabase()", async () => {
    // `authDatabase(name)` returns a new adapter on each call, and each adapter uses the Database of the current request.
    const authDatabase = (name: string) => Object.assign(() => { throw new Error("Adapter must not run") }, { vitehubDatabase: name })
    const definition = defineAuth(({ request }) => ({ appName: "ViteHub", database: authDatabase(request?.headers.get("x-database") ?? "default") }))
    const guard = withAuth(() => "ok", definition)
    const send = (database?: string) => guard(new Request("https://app.example/private", { headers: { cookie: "session=1", ...(database ? { "x-database": database } : {}) } }))
    await send()
    await send()
    expect(provider.betterAuth).toHaveBeenCalledOnce()
    await send("other")
    expect(provider.betterAuth).toHaveBeenCalledTimes(2)
  })

  it("builds another instance for another baseURL", async () => {
    const guard = withAuth(() => "ok", defineAuth({ appName: "ViteHub" }))
    await guard(request("https://one.example/private"))
    await guard(request("https://two.example/private"))
    await guard(request("https://one.example/private"))
    expect(provider.betterAuth).toHaveBeenCalledTimes(2)
    expect(provider.betterAuth.mock.calls.map(([options]) => options.baseURL)).toEqual(["https://one.example", "https://two.example"])
  })

  it("builds another instance for another proxy trust result or secret", async () => {
    const guard = withAuth(() => "ok", defineAuth(({ request }) => ({
      advanced: { trustedProxyHeaders: request?.headers.get("x-trust") === "1" },
      secret: request?.headers.get("x-secret") ?? undefined,
    })))
    const send = (headers: Record<string, string>) => guard(new Request("https://app.example/private", { headers: { cookie: "session=1", ...headers } }))
    await send({})
    await send({ "x-trust": "1" })
    await send({ "x-secret": "another-secret-at-least-32-bytes-long" })
    await send({})
    expect(provider.betterAuth).toHaveBeenCalledTimes(3)
  })

  it.each([
    ["BETTER_AUTH_SECRET", "first-secret-at-least-32-characters", "second-secret-at-least-32-characters"],
    ["AUTH_SECRET", "first-secret-at-least-32-characters", "second-secret-at-least-32-characters"],
    ["BETTER_AUTH_SECRETS", "1:first-secret-at-least-32-characters", "2:second-secret-at-least-32-characters"],
    ["BETTER_AUTH_TRUSTED_ORIGINS", "https://one.example", "https://two.example"],
  ])("builds another instance when Better Auth's %s changes", async (name, first, second) => {
    const guard = withAuth(() => "ok", defineAuth({ appName: "ViteHub" }))
    vi.stubEnv(name, first)
    await guard(request("https://app.example/one"))
    await guard(request("https://app.example/two"))
    vi.stubEnv(name, second)
    await guard(request("https://app.example/three"))
    expect(provider.betterAuth).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])("does not read the environment values that the options replace in a callback=%s Definition", async (callback) => {
    vi.stubEnv("VITEHUB_ADMIN_CLAIM", "not-a-hash")
    vi.stubEnv("VITEHUB_SECRET", "short")
    const secret = "explicit-secret-at-least-32-characters"
    for (const runtime of [{ secret }, { secrets: [{ version: 1, value: secret }] }]) {
      const definition = callback ? defineAuth(() => ({ adminClaim: false, ...runtime })) : defineAuth({ adminClaim: false, runtime })
      expect((await handleAuthRequest(definition, request("https://app.example/api/auth/ok"))).status).toBe(200)
      expect(await withAuth(() => "ok", definition)(request("https://app.example/private"))).toBe("ok")
    }
  })

  it("does not share an instance that captured the bindings of another request", async () => {
    const definition = defineAuth(({ env }) => ({ appName: "ViteHub", database: env.DB as never }))
    class D1Binding {}
    setAuthRuntimeEnvResolver(() => ({ DB: new D1Binding() }), definition)
    const guard = withAuth(() => "ok", definition)
    await guard(request("https://app.example/one"))
    await guard(request("https://app.example/two"))
    expect(provider.betterAuth).toHaveBeenCalledTimes(2)
    expect(provider.betterAuth.mock.calls[0]![0].database).not.toBe(provider.betterAuth.mock.calls[1]![0].database)
    setAuthRuntimeEnvResolver(undefined, definition)
  })

  it("builds the instance again after its setup failed", async () => {
    provider.betterAuth.mockImplementationOnce(() => {
      const $context = Promise.reject(new Error("setup failed"))
      $context.catch(() => {})
      return { $context, api: { getSession: provider.getSession }, handler: provider.handler }
    })
    const guard = withAuth(() => "ok", defineAuth({ appName: "ViteHub" }))
    await guard(request("https://app.example/one"))
    await new Promise(resolve => setTimeout(resolve))
    await guard(request("https://app.example/two"))
    expect(provider.betterAuth).toHaveBeenCalledTimes(2)
  })

  it("reuses the instance of the discovered Definition in useAuth()", () => {
    const first = useAuth(requestEvent(request("https://app.example/one")))
    expect(useAuth(request("https://app.example/two"))).toBe(first)
    expect(provider.betterAuth).toHaveBeenCalledOnce()
    expect(useAuth(request("https://other.example/one"))).not.toBe(first)
    expect(provider.betterAuth).toHaveBeenCalledTimes(2)
  })

  it("reads the session once for every guard of one request", async () => {
    const definition = defineAuth({ access: { routes: ["/private/**"] }, appName: "ViteHub" })
    const access = createAuthAccessHandler([{ route: "/private/**" }], definition)
    const handler = withAuthorization(true, withAuth(() => "ok", definition), definition)
    const app = new H3().get("/private/data", async (event) => {
      expect(await access(event)).toBeUndefined()
      await requireAuth(event, definition)
      return handler(event)
    })

    expect(await (await app.fetch(request("https://app.example/private/data"))).text()).toBe("ok")
    expect(provider.getSession).toHaveBeenCalledOnce()

    await app.fetch(request("https://app.example/private/data"))
    expect(provider.getSession).toHaveBeenCalledTimes(2)
  })
})
