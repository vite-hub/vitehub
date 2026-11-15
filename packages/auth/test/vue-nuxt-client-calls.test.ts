import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// One page request of a Nuxt server: its Nuxt app, its H3 event, and Nuxt's in-process fetch for it.
type Request = { app: { runWithContext<T>(run: () => T): T }, event: { req: { headers: Headers }, res: { headers: Headers } }, native: ReturnType<typeof vi.fn> }

const mocks = vi.hoisted(() => ({ request: undefined as Request | undefined }))

vi.mock("#app", () => ({
  createError: (input: unknown) => Object.assign(new Error("nuxt"), input),
  defineNuxtPlugin: (plugin: unknown) => plugin,
  addRouteMiddleware: () => {},
  navigateTo: (target: unknown) => target,
  tryUseNuxtApp: () => mocks.request?.app,
  useRequestEvent: () => mocks.request?.event,
  useRequestFetch: () => Object.assign(() => Promise.resolve(null), { native: mocks.request?.native }),
  useRequestURL: () => new URL("http://localhost:3000/settings"),
  useRuntimeConfig: () => ({ public: { vitehubAuth: { basePath: "/auth" } } }),
  // The page already knows the session, so the plugin does not read it.
  useState: () => ({ value: null }),
}))

// Better Auth's real Vue client: only Nuxt is a stand-in.
const { createAuthClient, loadAuthClient, useAuthClient } = await import("../src/vue.ts")
const { default: plugin } = await import("../src/runtime/vue-nuxt.ts") as {
  default: { setup: (app: { payload: object }) => Promise<void> }
}

/** A page request whose in-process fetch answers `body` and sets `cookies`. */
function pageRequest(body: unknown, cookies: string[] = []): Request {
  const native = vi.fn(async (_path: string, _init?: RequestInit) => {
    const headers = new Headers({ "content-type": "application/json" })
    for (const cookie of cookies) headers.append("set-cookie", cookie)
    return new Response(JSON.stringify(body), { headers })
  })
  return {
    app: { runWithContext: run => run() },
    event: { req: { headers: new Headers({ cookie: "better-auth.session_token=visitor" }) }, res: { headers: new Headers() } },
    native,
  }
}

const globalFetch = vi.fn(async () => new Response("left the process", { status: 599 }))

beforeEach(async () => {
  vi.stubGlobal("fetch", globalFetch)
  // Better Auth's client builds an absolute URL from VERCEL_URL on the server.
  vi.stubEnv("VERCEL_URL", "my-app.vercel.app")
  mocks.request = pageRequest(null)
  await plugin.setup({ payload: {} })
})

afterEach(() => {
  mocks.request = undefined
  globalFetch.mockClear()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("Auth client calls during Nuxt server rendering", () => {
  it("calls the app in-process with the path only, with the page request's fetch", async () => {
    const sessions = [{ id: "s1", userId: "u1" }]
    const request = mocks.request = pageRequest(sessions)
    const client = createAuthClient({ basePath: "/api/auth" })

    const result = await client.listSessions()

    expect(result).toEqual({ data: sessions, error: null })
    expect(request.native).toHaveBeenCalledTimes(1)
    expect(request.native.mock.calls[0]?.[0]).toBe("/api/auth/list-sessions")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("calls the default client in-process at the Definition's basePath", async () => {
    const request = mocks.request = pageRequest([])

    await useAuthClient().listSessions()

    expect(request.native.mock.calls[0]?.[0]).toBe("/auth/list-sessions")
    expect(globalFetch).not.toHaveBeenCalled()
  })

  it("sends the method, query, and body of a plugin endpoint", async () => {
    const request = mocks.request = pageRequest({ status: true })
    const client = createAuthClient({ basePath: "/app/auth" })

    await client.$fetch("/organization/set-active", { method: "POST", body: { organizationId: "o1" }, query: { from: "ssr" } })

    const [path, init] = request.native.mock.calls[0] ?? []
    expect(path).toBe("/app/auth/organization/set-active?from=ssr")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({ organizationId: "o1" })
  })

  it("forwards a cookie that Better Auth refreshed to the page response", async () => {
    const request = mocks.request = pageRequest([], ["better-auth.session_token=refreshed; Path=/; HttpOnly"])
    const client = createAuthClient({ basePath: "/api/auth" })

    await client.listSessions()

    expect(request.event.res.headers.getSetCookie()).toEqual(["better-auth.session_token=refreshed; Path=/; HttpOnly"])
  })

  it("keeps the calls of two requests apart", async () => {
    const client = createAuthClient({ basePath: "/api/auth" })
    const first = mocks.request = pageRequest([{ id: "first" }])
    const firstCall = client.listSessions()
    const second = mocks.request = pageRequest([{ id: "second" }])
    const secondCall = client.listSessions()

    expect(await firstCall).toEqual({ data: [{ id: "first" }], error: null })
    expect(await secondCall).toEqual({ data: [{ id: "second" }], error: null })
    expect(first.native).toHaveBeenCalledTimes(1)
    expect(second.native).toHaveBeenCalledTimes(1)
  })

  it("creates one Better Auth client for each request, which loadAuthClient() returns", async () => {
    const client = createAuthClient({ basePath: "/api/auth" })
    mocks.request = pageRequest(null)
    const first = await loadAuthClient(client)
    expect(await loadAuthClient(client)).toBe(first)
    mocks.request = pageRequest(null)
    expect(await loadAuthClient(client)).not.toBe(first)
  })

  it("keeps a client with its own baseURL on Better Auth's fetch", async () => {
    const request = mocks.request = pageRequest([])
    const client = createAuthClient({ baseURL: "https://auth.example.com", basePath: "/api/auth" })

    await client.listSessions()

    expect(request.native).not.toHaveBeenCalled()
    expect(globalFetch).toHaveBeenCalledTimes(1)
  })
})
