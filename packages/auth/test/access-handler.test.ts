import { beforeEach, describe, expect, it, vi } from "vitest"
import { runInNewContext } from "node:vm"

import { defineAuth } from "../src/index.ts"
import { createAuthAccessHandler } from "../src/server.ts"

const provider = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  getSession: vi.fn(),
  handler: vi.fn(),
}))

vi.mock("better-auth", () => ({ betterAuth: provider.betterAuth }))

const session = { session: { id: "session" }, user: { id: "user" } }

describe("Auth access handlers", () => {
  beforeEach(() => {
    provider.betterAuth.mockReset().mockReturnValue({
      api: { getSession: provider.getSession },
      handler: provider.handler,
    })
    provider.getSession.mockReset().mockResolvedValue(session)
    provider.handler.mockReset()
  })

  it.each(["web", "host"] as const)("matches exact, recursive and method rules for %s requests", async (adapter) => {
    const authorize = vi.fn(() => true)
    const definition = defineAuth({ access: { routes: [
      { route: "/private", authorize },
      { route: "/admin/**", method: "post", authorize },
      { route: "/patch", method: "PATCH", authorize },
    ] } })
    const handler = createAuthAccessHandler([
      { route: "/private", authorize: true },
      { route: "/admin/**", method: "post", authorize: true },
      { route: "/patch", method: "PATCH", authorize: true },
    ], definition)

    for (const [path, method, matches] of [
      ["/private?next=/public", "GET", true],
      ["/private/child", "GET", false],
      ["/private-other", "GET", false],
      ["/admin", "POST", true],
      ["/admin/users", "POST", true],
      ["/admin/users", "GET", false],
      ["/administrator", "POST", false],
      ["/patch", "patch", true],
    ] as const) {
      authorize.mockClear()
      provider.getSession.mockClear()
      const request = new Request(`https://app.example${path}`, { method })
      await expect(handler(adapter === "host" ? { req: request } : request)).resolves.toBeUndefined()
      expect(authorize).toHaveBeenCalledTimes(matches ? 1 : 0)
      expect(provider.getSession).toHaveBeenCalledTimes(matches ? 1 : 0)
      if (matches) expect(authorize).toHaveBeenCalledWith({ request, ...session })
    }
  })

  it("does not resolve Auth for unmatched requests", async () => {
    const handler = createAuthAccessHandler([{ route: "/private/**" }])
    await expect(handler(new Request("https://app.example/public"))).resolves.toBeUndefined()
    expect(provider.betterAuth).not.toHaveBeenCalled()
  })

  it("requires every overlapping authorization rule using one Definition snapshot", async () => {
    const first = vi.fn(() => true)
    const second = vi.fn(() => false)
    const resolve = vi.fn(() => ({ access: { routes: [
      { route: "/admin/**", authorize: first },
      { route: "/admin/users", authorize: second },
    ] } }))
    const handler = createAuthAccessHandler([
      { route: "/admin/**", authorize: true },
      { route: "/admin/users", authorize: true },
    ], defineAuth(resolve))

    expect((await handler(new Request("https://app.example/admin/users")))?.status).toBe(403)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(resolve).toHaveBeenCalledOnce()
    expect(provider.getSession).toHaveBeenCalledOnce()
  })

  it("fails closed when a discovered authorize callback is absent at runtime", async () => {
    const handler = createAuthAccessHandler([{ route: "/admin/**", authorize: true }], defineAuth(() => ({
      access: { routes: ["/admin/**"] },
    })))
    expect((await handler(new Request("https://app.example/admin/users")))?.status).toBe(403)
  })

  it("preserves missing runtime route diagnostics", async () => {
    const handler = createAuthAccessHandler([{ route: "/admin/**", authorize: true }], defineAuth(() => ({
      access: { routes: [] },
    })))
    await expect(handler(new Request("https://app.example/admin/users"))).rejects.toMatchObject({ code: "AUTH_R0008" })
  })

  it("returns custom authorization responses unchanged", async () => {
    const response = new Response("Policy rejected", { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response }] },
    }))
    await expect(handler(new Request("https://app.example/"))).resolves.toBe(response)
    await expect(response.text()).resolves.toBe("Policy rejected")
  })

  it("rejects native responses with shadowed header iterators", async () => {
    const response = new Response("Policy rejected", { status: 409 })
    Object.defineProperty(response.headers, "forEach", { value: () => {} })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response }] },
    }))
    expect((await handler(new Request("https://app.example/")))!.status).toBe(403)
  })

  it("rejects native responses with a shadowed body reader", async () => {
    const response = new Response("Policy rejected", { status: 409 })
    Object.defineProperty(response.body!, "getReader", { value: () => ({ read: () => Promise.resolve({ done: true }) }) })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response }] },
    }))
    expect((await handler(new Request("https://app.example/")))!.status).toBe(403)
  })

  it("rejects native responses with unusable headers", async () => {
    const response = new Response("Policy rejected", { status: 409 })
    Object.defineProperty(response.headers, "forEach", { value: undefined })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response }] },
    }))
    expect((await handler(new Request("https://app.example/")))!.status).toBe(403)
  })

  it("rejects a forged response body with an unusable reader", async () => {
    const forgedResponse = {
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      body: { getReader: () => ({}) },
      [Symbol.toStringTag]: "Response",
    }
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => forgedResponse as never }] },
    }))
    expect((await handler(new Request("https://app.example/")))!.status).toBe(403)
  })

  it("cleans up an acquired malformed foreign reader", async () => {
    let cancelled = false
    const foreignResponse = {
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      body: {
        cancel: () => { cancelled = true },
        getReader: () => ({
          cancel: () => { cancelled = true },
        }),
      },
      [Symbol.toStringTag]: "Response",
    }
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))
    expect((await handler(new Request("https://app.example/")))!.status).toBe(403)
    expect(cancelled).toBe(true)
  })

  it("cancels the foreign body when reader release throws", async () => {
    let cancelled = false
    const foreignResponse = {
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      body: {
        cancel: () => { cancelled = true },
        getReader: () => ({
          read: () => Promise.resolve({ done: true, value: undefined }),
          releaseLock: () => { throw new Error("locked") },
        }),
      },
      [Symbol.toStringTag]: "Response",
    }
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))
    expect((await handler(new Request("https://app.example/")))!.status).toBe(409)
    expect(cancelled).toBe(true)
  })

  it("falls back to the foreign body when reader cancellation throws", async () => {
    let cancelled = false
    const foreignResponse = {
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      body: {
        cancel: () => { cancelled = true },
        getReader: () => ({
          read: () => Promise.reject(new Error("read failed")),
          cancel: () => { throw new Error("cancel failed") },
          releaseLock: () => { throw new Error("locked") },
        }),
      },
      [Symbol.toStringTag]: "Response",
    }
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))
    expect(response!.status).toBe(409)
    await expect(response!.text()).rejects.toThrow("read failed")
    expect(cancelled).toBe(true)
  })

  it("releases the reader after cancellation succeeds", async () => {
    let released = false
    const foreignResponse = {
      status: 409,
      statusText: "Conflict",
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => Promise.reject(new Error("read failed")),
          cancel: () => undefined,
          releaseLock: () => { released = true },
        }),
      },
      [Symbol.toStringTag]: "Response",
    }
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))
    expect(response!.status).toBe(409)
    expect(released).toBe(true)
  })

  it.each([
    Response.error(),
    { status: 409, statusText: "Conflict", headers: { get() { return null } }, body: null, [Symbol.toStringTag]: "Response" },
  ])("rejects responses that cannot be serialized", async (response) => {
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response as never }] },
    }))
    expect((await handler(new Request("https://app.example/")))!.status).toBe(403)
  })

  it("normalizes authorization responses from another realm", async () => {
    const foreignResponse = runInNewContext(`new (class {
      get status() { return 409 }
      get statusText() { return "Conflict" }
      get headers() { return new Headers({ "x-policy": "denied" }) }
      get body() { return null }
      get [Symbol.toStringTag]() { return "Response" }
    })()`, { Headers })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))
    expect(response).toBeInstanceOf(Response)
    expect(response!.status).toBe(409)
    expect(response!.headers.get("x-policy")).toBe("denied")
  })

  it("rejects foreign responses with malformed cookie metadata", async () => {
    const headers = new Headers({ "set-cookie": "sid=abc" })
    Object.defineProperty(headers, "getSetCookie", { value: () => "sid=abc" })
    const foreignResponse = {
      status: 409,
      statusText: "Conflict",
      headers,
      body: null,
      [Symbol.toStringTag]: "Response",
    }
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))

    expect((await handler(new Request("https://app.example/")))!.status).toBe(403)
  })

  it("starts provider sign-in only for matched unauthenticated HTML requests", async () => {
    provider.getSession.mockResolvedValue(null)
    provider.handler.mockResolvedValue(Response.json({ url: "https://provider.example/sign-in" }))
    const authorize = vi.fn(() => true)
    const handler = createAuthAccessHandler([{ route: "/private", authorize: true }], defineAuth({
      access: {
        routes: [{ route: "/private", authorize }],
        signIn: { provider: "github", callbackURL: "/private" },
      },
    }))
    const response = await handler(new Request("https://app.example/private", { headers: { accept: "text/html" } }))
    expect(response?.status).toBe(302)
    expect(response?.headers.get("location")).toBe("https://provider.example/sign-in")
    expect(authorize).not.toHaveBeenCalled()

    provider.handler.mockClear()
    expect((await handler(new Request("https://app.example/private")))?.status).toBe(401)
    expect(provider.handler).not.toHaveBeenCalled()
  })
})
