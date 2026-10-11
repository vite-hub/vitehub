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
  })

  it("returns authorization responses from another realm unchanged", async () => {
    const foreignResponse = runInNewContext(`new Response("Policy rejected", { status: 409 })`, { Response })
    const handler = createAuthAccessHandler([{ route: "/**", authorize: true }], defineAuth({
      access: { routes: [{ route: "/**", authorize: () => foreignResponse as never }] },
    }))

    await expect(handler(new Request("https://app.example/"))).resolves.toBe(foreignResponse)
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
