import { H3 } from "h3"
import { describe, expect, it, vi } from "vitest"

const loaded = vi.hoisted(() => new Set<string>())

vi.mock("better-auth", () => {
  loaded.add("better-auth")
  return {}
})
vi.mock("better-auth/api", () => {
  loaded.add("better-auth/api")
  return {}
})
vi.mock("better-auth/cookies", () => {
  loaded.add("better-auth/cookies")
  return {}
})

const { authAccessHandlerMeta, createLazyAuthAccessHandler } = await import("../src/runtime/server.ts")

describe("Auth startup runtime", () => {
  it("loads the Auth server only for a request that an access route matches", async () => {
    const check = vi.fn(async () => new Response(null, { status: 401 }))
    const load = vi.fn(async () => ({ createAuthAccessHandler: () => check }))
    const handler = createLazyAuthAccessHandler([{ route: "/private/**", authorize: true }], load)

    await expect(handler(new Request("https://app.example/public"))).resolves.toBeUndefined()
    expect(load).not.toHaveBeenCalled()

    await expect(handler(new Request("https://app.example/private/a"))).resolves.toMatchObject({ status: 401 })
    await expect(handler(new Request("https://app.example/private/b"))).resolves.toMatchObject({ status: 401 })
    expect(load).toHaveBeenCalledOnce()
    expect(check).toHaveBeenCalledTimes(2)
    expect([...loaded]).toEqual([])
  })

  it("skips public routes without loading the Auth server", async () => {
    const check = vi.fn(async () => new Response(null, { status: 401 }))
    const load = vi.fn(async () => ({ createAuthAccessHandler: () => check }))
    const handler = createLazyAuthAccessHandler([{ route: "/**" }], load, ["/", "/health"])

    await expect(handler(new Request("https://app.example/"))).resolves.toBeUndefined()
    await expect(handler(new Request("https://app.example/health"))).resolves.toBeUndefined()
    expect(load).not.toHaveBeenCalled()

    await expect(handler(new Request("https://app.example/private"))).resolves.toMatchObject({ status: 401 })
  })

  it("loads the Auth server again after a failed load", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValue({ createAuthAccessHandler: () => async () => undefined })
    const handler = createLazyAuthAccessHandler([{ route: "/private" }], load)

    await expect(handler(new Request("https://app.example/private"))).rejects.toThrow("load failed")
    await expect(handler(new Request("https://app.example/private"))).resolves.toBeUndefined()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it("leaves a request to the handler that Nitro routed it to only when that handler checks its own access", async () => {
    const check = vi.fn(async () => new Response(null, { status: 401 }))
    const handler = createLazyAuthAccessHandler([{ route: "/**" }], async () => ({ createAuthAccessHandler: () => check }))
    // A request event as Nitro passes it to middleware: the route that it matched is on its context.
    const event = (matchedRoute?: { route: string, method?: string, meta?: Record<string, unknown> }) => ({
      "~standard": { vendor: "test", req: new Request("https://app.example/_vitehub/rpc", { method: "POST" }), res: { headers: new Headers() } },
      context: { matchedRoute },
    })

    await expect(handler(event({ route: "/_vitehub/rpc", meta: { ...authAccessHandlerMeta } }))).resolves.toBeUndefined()
    expect(check).not.toHaveBeenCalled()
    // An app route file on the same path, a route without the meta, and a plain Request keep the access routes.
    await expect(handler(event({ route: "/_vitehub/rpc", method: "post" }))).resolves.toMatchObject({ status: 401 })
    await expect(handler(event({ route: "/_vitehub/rpc", meta: { vitehubAuthAccess: "app" } }))).resolves.toMatchObject({ status: 401 })
    await expect(handler(event())).resolves.toMatchObject({ status: 401 })
    await expect(handler(new Request("https://app.example/_vitehub/rpc", { method: "POST" }))).resolves.toMatchObject({ status: 401 })
    expect(check).toHaveBeenCalledTimes(4)
  })

  it("tells app middleware which requests a ViteHub route checks itself, from the root entry", async () => {
    const { checksOwnAccess } = await import("../src/index.ts")
    const { ownAccessHandlerMeta, ownAccessRouteMeta } = await import("@vite-hub/internal/nitro-kit")
    const event = (meta?: Record<string, unknown>) => ({
      "~standard": { vendor: "test", req: new Request("https://app.example/_vitehub/realtime/room"), res: { headers: new Headers() } },
      context: { matchedRoute: { route: "/_vitehub/realtime/**", ...meta ? { meta } : {} } },
    })

    expect(authAccessHandlerMeta).toEqual(ownAccessHandlerMeta)
    expect(checksOwnAccess(event({ ...ownAccessRouteMeta }))).toBe(true)
    expect(checksOwnAccess(event({ ...ownAccessHandlerMeta }))).toBe(true)
    expect(checksOwnAccess(event({ vitehubOwnAccess: "yes" }))).toBe(false)
    expect(checksOwnAccess(event())).toBe(false)
    expect(checksOwnAccess(new Request("https://app.example/_vitehub/realtime/room"))).toBe(false)
    expect([...loaded]).toEqual([])
  })

  it("keeps an app access rule on a ViteHub route that checks its own access", async () => {
    const { checksOwnAccess } = await import("../src/index.ts")
    const { ownAccessRouteMeta } = await import("@vite-hub/internal/nitro-kit")
    const check = vi.fn(async () => new Response(null, { status: 403 }))
    // An app that lets only admins use Realtime.
    const handler = createLazyAuthAccessHandler([{ route: "/_vitehub/realtime/**", authorize: true }], async () => ({ createAuthAccessHandler: () => check }))
    const app = new H3()
      .use(event => checksOwnAccess(event) ? handler(event) : new Response(null, { status: 401 }))
      .get("/_vitehub/realtime/**", () => "realtime", { meta: { ...ownAccessRouteMeta } })
      .get("/_vitehub/realtime/app-route", () => "app")

    expect((await app.request("/_vitehub/realtime/room")).status).toBe(403)
    expect((await app.request("/_vitehub/realtime/app-route")).status).toBe(401)
    expect(check).toHaveBeenCalledOnce()
  })
})
