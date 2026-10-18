import { runInNewContext } from "node:vm"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Response as ForeignResponse } from "undici"

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

  describe("authorize results", () => {
    const run = async (result: unknown) => {
      const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
        access: { routes: [{ route: "/**", authorize: () => result as never }] },
      }))
      return handler(new Request("https://app.example/"))
    }

    // A Response of this runtime passes the native `status` getter of `Response.prototype`.
    // ViteHub sends it as the rejection and does not copy or inspect it.
    it.each([
      ["a Response with separate Set-Cookie headers", () => new Response("Policy rejected", {
        status: 409,
        headers: [["set-cookie", "first=1"], ["set-cookie", "second=2"], ["x-policy", "reject"]],
      })],
      ["Response.error()", () => Response.error()],
    ])("returns %s unchanged", async (_name, create) => {
      const source = await create()
      await expect(run(source)).resolves.toBe(source)
    })

  })

  describe("foreign status, body, and separate Set-Cookie headers", () => {
    const foreign = new ForeignResponse("Policy rejected", {
      status: 409,
      statusText: "Policy conflict",
      headers: [["set-cookie", "first=1"], ["set-cookie", "second=2"], ["x-policy", "reject"]],
    })

    // Only `true` grants access. Every value that is not a Response of this runtime gets the default 403.
    it.each([
      ["false", () => false],
      ["undefined", () => undefined],
      ["a string", () => "allow"],
      ["a plain object", () => ({ status: 200 })],
      ["a Response from another Fetch implementation with one cookie and no getSetCookie", () => {
        const response = new ForeignResponse("Policy rejected", { status: 409, headers: { "set-cookie": "first=1" } })
        Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
        return response
      }],
      ["a Response created in another realm", () => runInNewContext(`new Response("Policy rejected", { status: 409 })`, { Response: ForeignResponse })],
      ["a proxy around a Response", () => new Proxy(new Response("Policy rejected", { status: 409 }), {})],
      ["an object created from Response.prototype", () => Object.create(Response.prototype)],
      ["an object tagged Response", () => ({ status: 409, statusText: "Conflict", headers: new Headers(), [Symbol.toStringTag]: "Response" })],
      ["an instance of a class named Response", () => runInNewContext(`new (class Response {
        get status() { return 409 }
        get headers() { return new Headers({ "x-policy": "forged" }) }
        get body() { return null }
      })()`, { Headers })],
      ["a proxy whose reflection throws", () => new Proxy({}, {
        getPrototypeOf: () => { throw new Error("reflection failed") },
        getOwnPropertyDescriptor: () => { throw new Error("reflection failed") },
      })],
    ])("returns 403 for %s", async (_name, create) => {
      const result = await run(create())
      expect(result).toBeInstanceOf(Response)
      expect(result?.status).toBe(403)
      expect(result?.headers.has("x-policy")).toBe(false)
      await expect(result?.json()).resolves.toEqual({ error: "Forbidden." })
    })

  })

  it("preserves one foreign Set-Cookie header without getSetCookie", async () => {
    const foreign = new ForeignResponse("Policy rejected", {
      status: 409,
      headers: { "set-cookie": "session=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/" },
    })
    Object.defineProperty(foreign.headers, "getSetCookie", { value: undefined })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(409)
    expect(response?.headers.get("set-cookie")).toBe("session=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/")
  })

  it("rejects ambiguous cookie extensions without getSetCookie", async () => {
    const foreign = new ForeignResponse(null, {
      status: 302,
      headers: { "set-cookie": "session=one; Extension=alpha, beta=gamma" },
    })
    Object.defineProperty(foreign.headers, "getSetCookie", { value: undefined })

    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(403)
  })

  it.each(["read", "cancel"] as const)("preserves a foreign stream with a different reader method on %s", async action => {
    const cancel = vi.fn()
    const bytes = new Uint8Array([65, 66])
    const body = runInNewContext(`
      new (class extends ReadableStream {
        getReader(...args) { return super.getReader(...args) }
      })({
        start(controller) { controller.enqueue(bytes) },
        cancel,
      })
    `, { ReadableStream, bytes, cancel }) as ReadableStream<Uint8Array>
    const foreign = new ForeignResponse(body as never, { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))
    const response = await handler(new Request("https://app.example/"))
    expect(response?.status).toBe(409)
    if (action === "read") {
      await expect(response?.text()).resolves.toBe("AB")
    }
    else {
      await response?.body?.cancel()
      expect(cancel).toHaveBeenCalled()
    }
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
