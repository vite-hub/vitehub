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

  it("passes public routes to the Auth server and skips them without loading it", async () => {
    const check = vi.fn(async () => new Response(null, { status: 401 }))
    const load = vi.fn(async () => ({ createAuthAccessHandler: vi.fn(() => check) }))
    const handler = createLazyAuthAccessHandler([{ route: "/**" }], load, ["/", "/health"])

    await expect(handler(new Request("https://app.example/"))).resolves.toBeUndefined()
    await expect(handler(new Request("https://app.example/health"))).resolves.toBeUndefined()
    expect(load).not.toHaveBeenCalled()

    await expect(handler(new Request("https://app.example/private"))).resolves.toMatchObject({ status: 401 })
    const { createAuthAccessHandler } = await load.mock.results[0]!.value
    expect(createAuthAccessHandler).toHaveBeenCalledWith([{ route: "/**" }], undefined, ["/", "/health"])
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
})
