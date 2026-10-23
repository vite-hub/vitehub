import { H3 } from "h3"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { getAuthorization, requireAuth, requireAuthorization } from "../src/server.ts"

import type { H3Event } from "h3"

const providerMocks = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  getSession: vi.fn(),
  handler: vi.fn(),
}))

vi.mock("better-auth", () => ({
  betterAuth: providerMocks.betterAuth,
}))

const definition = defineAuth({ appName: "ViteHub" })
const signedIn = { session: { id: "session-1" }, user: { id: "user-1" } }

function readUser(event: H3Event) {
  const { session, user } = getAuthorization(event)
  return { session: session.id, user: user.id }
}

describe("Auth route middleware", () => {
  beforeEach(() => {
    providerMocks.betterAuth.mockReset()
    providerMocks.getSession.mockReset()
    providerMocks.handler.mockReset()
    providerMocks.betterAuth.mockReturnValue({
      api: { getSession: providerMocks.getSession },
      handler: providerMocks.handler,
    })
  })

  describe("requireAuth", () => {
    it("runs the H3 route handler with the checked authorization", async () => {
      const handler = vi.fn(readUser)
      const app = new H3().get("/me", handler, { middleware: [requireAuth(definition)] })
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/me", { headers: { cookie: "session=1" } }))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ session: "session-1", user: "user-1" })
      expect(providerMocks.getSession.mock.calls[0]?.[0].headers.get("cookie")).toBe("session=1")
      const authorization = getAuthorization(handler.mock.calls[0]![0])
      expect(authorization.request.url).toBe("https://example.com/me")
      expect(Object.isFrozen(authorization)).toBe(true)
    })

    it("returns JSON 401 without a session and does not run the handler", async () => {
      const handler = vi.fn(readUser)
      const app = new H3().get("/me", handler, { middleware: [requireAuth(definition)] })
      providerMocks.getSession.mockResolvedValue(null)

      const response = await app.fetch(new Request("https://example.com/me"))

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: "Unauthorized." })
      expect(handler).not.toHaveBeenCalled()
    })

    it("starts the access.signIn redirect for an HTML request", async () => {
      const handler = vi.fn(readUser)
      const signInDefinition = defineAuth({ access: { signIn: { provider: "github" } }, appName: "ViteHub" })
      const app = new H3().get("/app", handler, { middleware: [requireAuth(signInDefinition)] })
      providerMocks.getSession.mockResolvedValue(null)
      providerMocks.handler.mockResolvedValue(Response.json({ url: "https://github.com/login/oauth/authorize" }))

      const response = await app.fetch(new Request("https://example.com/app", { headers: { accept: "text/html" } }))

      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("https://github.com/login/oauth/authorize")
      expect(handler).not.toHaveBeenCalled()
    })
  })

  describe("requireAuthorization", () => {
    it("runs the handler after the callback accepts the request", async () => {
      const authorize = vi.fn(({ user }: { user: { id: string } }) => user.id === "user-1")
      const app = new H3().delete("/posts/1", readUser, { middleware: [requireAuthorization(authorize, definition)] })
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/posts/1", { method: "DELETE" }))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ session: "session-1", user: "user-1" })
      expect(authorize).toHaveBeenCalledWith(expect.objectContaining(signedIn))
    })

    it("returns 403 when the callback returns false", async () => {
      const handler = vi.fn(readUser)
      const app = new H3().delete("/posts/1", handler, { middleware: [requireAuthorization(() => false, definition)] })
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/posts/1", { method: "DELETE" }))

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: "Forbidden." })
      expect(handler).not.toHaveBeenCalled()
    })

    it("returns the callback's Response as-is", async () => {
      const handler = vi.fn(readUser)
      const app = new H3().get("/photos/1", handler, {
        middleware: [requireAuthorization(() => new Response("Not your photo", { status: 404 }), definition)],
      })
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/photos/1"))

      expect(response.status).toBe(404)
      expect(await response.text()).toBe("Not your photo")
      expect(handler).not.toHaveBeenCalled()
    })

    it("returns JSON 401 without a session and never redirects to sign-in", async () => {
      const signInDefinition = defineAuth({ access: { signIn: { provider: "github" } }, appName: "ViteHub" })
      const app = new H3().get("/photos/1", readUser, { middleware: [requireAuthorization(true, signInDefinition)] })
      providerMocks.getSession.mockResolvedValue(null)

      const response = await app.fetch(new Request("https://example.com/photos/1", { headers: { accept: "text/html" } }))

      expect(response.status).toBe(401)
      expect(response.headers.get("location")).toBeNull()
      expect(providerMocks.handler).not.toHaveBeenCalled()
    })

    it("rejects an authorize value that is not true or a function", () => {
      // SAFETY: The test deliberately violates the input contract to prove the runtime guard.
      expect(() => requireAuthorization(false as never, definition)).toThrow(expect.objectContaining({ code: "AUTH_R0014" }))
    })
  })

  describe("getAuthorization", () => {
    it("throws for an event that no Auth middleware accepted", async () => {
      const app = new H3().get("/me", readUser)

      const response = await app.fetch(new Request("https://example.com/me"))

      expect(response.status).toBe(500)
      expect(providerMocks.getSession).not.toHaveBeenCalled()
      expect(() => getAuthorization({ req: new Request("https://example.com/me") })).toThrow(expect.objectContaining({ code: "AUTH_R0017" }))
    })

    it("ignores an authorization that other code puts on the event", async () => {
      const event = { context: { auth: signedIn, authorization: signedIn }, req: new Request("https://example.com/me") }

      expect(() => getAuthorization(event)).toThrow(expect.objectContaining({ code: "AUTH_R0017" }))
    })

    it("keeps the authorization with the event that the middleware checked", async () => {
      const middleware = requireAuth(definition)
      const checked = { req: new Request("https://example.com/me") }
      const other = { req: new Request("https://example.com/me") }
      providerMocks.getSession.mockResolvedValue(signedIn)

      await expect(middleware(checked, () => "next")).resolves.toBe("next")

      expect(getAuthorization(checked).user).toEqual({ id: "user-1" })
      expect(() => getAuthorization(other)).toThrow(expect.objectContaining({ code: "AUTH_R0017" }))
    })
  })
})
