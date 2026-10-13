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

  it("returns custom authorization responses unchanged", async () => {
    const response = new Response("Policy rejected", { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response }] },
    }))
    await expect(handler(new Request("https://app.example/"))).resolves.toBe(response)
  })

  it("normalizes authorization responses from another runtime", async () => {
    const foreignResponse = new ForeignResponse("Policy rejected", { status: 409 })
    expect(foreignResponse).not.toBeInstanceOf(Response)
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))
    expect(response).toBeInstanceOf(Response)
    expect(response?.status).toBe(409)
    await expect(response?.text()).resolves.toBe("Policy rejected")
  })

  it.each([["local", Response], ["foreign", ForeignResponse]] as const)("preserves authorization responses without getSetCookie from the %s runtime", async (_runtime, ResponseConstructor) => {
    const response = new ResponseConstructor("Policy rejected", { status: 409 })
    Object.defineProperty(response.headers, "getSetCookie", { value: undefined })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response as never }] },
    }))

    const result = await handler(new Request("https://app.example/"))
    expect(result?.status).toBe(409)
    await expect(result?.text()).resolves.toBe("Policy rejected")
    if (_runtime === "local") expect(result).toBe(response)
    else expect(result).toBeInstanceOf(Response)
  })

  it.each([["local", Response], ["foreign", ForeignResponse]] as const)("rejects unbranded objects with a Response prototype from the %s runtime", async (_runtime, ResponseConstructor) => {
    const spoof = Object.create(ResponseConstructor.prototype) as never
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => spoof }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it("rejects response-shaped authorization spoofs", async () => {
    const spoof = {
      status: 409,
      statusText: "Conflict",
      headers: { get: () => null, getSetCookie: () => [], forEach: () => {} },
      body: null,
      [Symbol.toStringTag]: "Response",
    }
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => spoof as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
  })

  it("rejects a tagged custom prototype with stateful response getters", async () => {
    const headers = vi.fn()
      .mockReturnValueOnce(new Headers({ "x-policy": "reject" }))
      .mockImplementation(() => { throw new Error("unstable headers") })
    const prototype = Object.defineProperties({}, {
      [Symbol.toStringTag]: { value: "Response" },
      status: { get: () => 409 },
      statusText: { get: () => "Conflict" },
      headers: { get: headers },
      body: { get: () => null },
    })
    const spoof = Object.create(prototype)
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => spoof }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(403)
    expect(() => response?.headers.forEach(() => {})).not.toThrow()
  })

  it("rejects a foreign response whose body is locked", async () => {
    const response = new ForeignResponse("Policy rejected", { status: 409 })
    const reader = response.body!.getReader()
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => response as never }] },
    }))
    try {
      await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    }
    finally {
      reader.releaseLock()
    }
  })

  it("snapshots a serializable Response-shaped prototype without rereading its getters", async () => {
    const sourceBody = new Response("Policy rejected").body
    const headers = vi.fn()
      .mockReturnValueOnce(new Headers({ "x-policy": "reject" }))
      .mockImplementation(() => { throw new Error("unstable headers") })
    const body = vi.fn()
      .mockReturnValueOnce(sourceBody)
      .mockImplementation(() => { throw new Error("unstable body") })
    const prototype = Object.defineProperties({}, {
      constructor: { value: function Response() {} },
      [Symbol.toStringTag]: { value: "Response" },
      status: { get: () => 409 },
      statusText: { get: () => "Conflict" },
      headers: { get: headers },
      body: { get: body },
    })
    const candidate = Object.create(prototype)
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => candidate }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response).toBeInstanceOf(Response)
    expect(response).not.toBe(candidate)
    expect(response?.status).toBe(409)
    expect(response?.statusText).toBe("Conflict")
    expect(response?.headers.get("x-policy")).toBe("reject")
    await expect(response?.text()).resolves.toBe("Policy rejected")
    expect(headers).toHaveBeenCalledTimes(1)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it("preserves foreign status, body, and separate Set-Cookie headers", async () => {
    const foreign = new ForeignResponse("Policy rejected", {
      status: 409,
      statusText: "Policy conflict",
      headers: [["set-cookie", "first=1"], ["set-cookie", "second=2"], ["x-policy", "reject"]],
    })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response?.status).toBe(409)
    expect(response?.statusText).toBe("Policy conflict")
    expect(response?.headers.get("x-policy")).toBe("reject")
    expect(response?.headers.getSetCookie()).toEqual(["first=1", "second=2"])
    await expect(response?.text()).resolves.toBe("Policy rejected")
  })

  it("forwards cancellation to the foreign response body", async () => {
    const cancel = vi.fn()
    const foreign = new ForeignResponse(new ReadableStream({ cancel }), { status: 409 })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreign as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))
    await response?.body?.cancel("client disconnected")

    expect(cancel).toHaveBeenCalledWith("client disconnected")
  })

  it.each([["local", Response], ["foreign", ForeignResponse]] as const)("preserves status-zero error semantics from the %s runtime", async (_runtime, ResponseConstructor) => {
    const source = ResponseConstructor.error()
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => source as never }] },
    }))

    const response = await handler(new Request("https://app.example/"))

    expect(response).toBeInstanceOf(Response)
    expect(response?.status).toBe(0)
    expect(response?.type).toBe("error")
    expect(response?.body).toBeNull()
    if (_runtime === "local") expect(response).toBe(source)
  })

  it("rejects a foreign response with an overridden body reader", async () => {
    const source = new ForeignResponse("Policy rejected", { status: 409 })
    const getReader = vi.fn(() => { throw new Error("unstable reader") })
    Object.defineProperty(source.body, "getReader", { get: getReader })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => source as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toMatchObject({ status: 403 })
    expect(getReader).not.toHaveBeenCalled()
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
