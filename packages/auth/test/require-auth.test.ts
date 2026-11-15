import { H3, HTTPError } from "h3"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { requireAuth, requireAuthorization } from "../src/server.ts"

import type { AccessAuthorizeOption } from "@vite-hub/runtime"
import type { H3Event } from "h3"
import type { AuthDefinition } from "../src/types.ts"

const providerMocks = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  getSession: vi.fn(),
  handler: vi.fn(),
}))

vi.mock("better-auth", () => ({
  betterAuth: providerMocks.betterAuth,
}))

const definition = defineAuth({ appName: "ViteHub" })
const signInDefinition = defineAuth({ access: { signIn: { provider: "github" } }, appName: "ViteHub" })
const signedIn = { session: { id: "session-1" }, user: { id: "user-1" } }

function signedInApp(guardDefinition: AuthDefinition = definition) {
  const handler = vi.fn(async (event: H3Event) => {
    const { request, session, user } = await requireAuth(event, guardDefinition)
    return { session: session.id, url: request.url, user: user.id }
  })
  return { app: new H3().all("/**", handler), handler }
}

function authorizedApp(authorize: AccessAuthorizeOption, guardDefinition: AuthDefinition = definition) {
  const deleted = vi.fn()
  const app = new H3().all("/**", async (event) => {
    const { user } = await requireAuthorization(event, authorize, guardDefinition)
    deleted(user.id)
    return { user: user.id }
  })
  return { app, deleted }
}

describe("Auth inline guards", () => {
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
    it("returns the checked request, Session, and user", async () => {
      const { app } = signedInApp()
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/me", { headers: { cookie: "session=1" } }))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ session: "session-1", url: "https://example.com/me", user: "user-1" })
      expect(providerMocks.getSession.mock.calls[0]?.[0].headers.get("cookie")).toBe("session=1")
    })

    it("returns a frozen authorization", async () => {
      providerMocks.getSession.mockResolvedValue(signedIn)

      const authorization = await requireAuth(new Request("https://example.com/me"), definition)

      expect(Object.isFrozen(authorization)).toBe(true)
      expect(authorization.user).toEqual({ id: "user-1" })
    })

    it("throws an HTTPError 401 without a session", async () => {
      providerMocks.getSession.mockResolvedValue(null)

      const error = await requireAuth(new Request("https://example.com/me"), definition).catch((error: unknown) => error)

      expect(HTTPError.isError(error)).toBe(true)
      expect(error).toMatchObject({ data: { code: "SIGNED_OUT" }, message: "Unauthorized.", status: 401, statusText: "Unauthorized" })
    })

    it("answers JSON 401 from H3 without running the rest of the handler", async () => {
      const after = vi.fn()
      const app = new H3().get("/me", async (event) => {
        await requireAuth(event, definition)
        after()
        return "ok"
      })
      providerMocks.getSession.mockResolvedValue(null)

      const response = await app.fetch(new Request("https://example.com/me"))

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ data: { code: "SIGNED_OUT" }, message: "Unauthorized.", status: 401, statusText: "Unauthorized" })
      expect(after).not.toHaveBeenCalled()
    })

    it("starts the access.signIn redirect for an HTML request, with its cookies", async () => {
      const { app } = signedInApp(signInDefinition)
      providerMocks.getSession.mockResolvedValue(null)
      // The session marker reads the session cookie name from the context when a response sets cookies.
      providerMocks.betterAuth.mockReturnValue({
        $context: Promise.resolve({ authCookies: { sessionToken: { name: "session" } }, options: {} }),
        api: { getSession: providerMocks.getSession },
        handler: providerMocks.handler,
      })
      const signIn = Response.json({ url: "https://github.com/login/oauth/authorize" })
      signIn.headers.append("set-cookie", "state=1; Path=/")
      signIn.headers.append("set-cookie", "verifier=2; Path=/")
      providerMocks.handler.mockResolvedValue(signIn)

      const response = await app.fetch(new Request("https://example.com/app", { headers: { accept: "text/html" } }))

      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("https://github.com/login/oauth/authorize")
      expect(response.headers.getSetCookie()).toEqual(["state=1; Path=/", "verifier=2; Path=/"])
    })

    it("answers the refusal body for the text 403 after a failed sign-in", async () => {
      const { app } = signedInApp(signInDefinition)
      providerMocks.getSession.mockResolvedValue(null)

      const response = await app.fetch(new Request("https://example.com/app?auth_error=denied", { headers: { accept: "text/html" } }))

      expect(response.status).toBe(403)
      expect(response.statusText).toBe("Forbidden")
      expect(await response.json()).toEqual({ data: { code: "SIGNED_OUT" }, message: "Unauthorized.", status: 403, statusText: "Forbidden" })
      expect(providerMocks.handler).not.toHaveBeenCalled()
    })
  })

  describe("requireAuthorization", () => {
    it("returns the authorization after the callback accepts the request", async () => {
      const authorize = vi.fn(({ user }: { user: { id: string } }) => user.id === "user-1")
      const { app, deleted } = authorizedApp(authorize)
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/posts/1", { method: "DELETE" }))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ user: "user-1" })
      expect(authorize).toHaveBeenCalledWith(expect.objectContaining(signedIn))
      expect(deleted).toHaveBeenCalledWith("user-1")
    })

    it("throws 403 when the callback returns false", async () => {
      const { app, deleted } = authorizedApp(() => false)
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/posts/1", { method: "DELETE" }))

      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ data: { code: "FORBIDDEN" }, message: "Forbidden.", status: 403, statusText: "Forbidden" })
      expect(deleted).not.toHaveBeenCalled()
    })

    it("answers the refusal body for the text 403 that an HTML request gets", async () => {
      const { app, deleted } = authorizedApp(() => false)
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/posts/1", { headers: { accept: "text/html" } }))

      expect(response.status).toBe(403)
      expect(response.statusText).toBe("Forbidden")
      expect(await response.json()).toEqual({ data: { code: "FORBIDDEN" }, message: "Forbidden.", status: 403, statusText: "Forbidden" })
      expect(deleted).not.toHaveBeenCalled()
    })

    it("throws the status, headers, and text of the callback's Response", async () => {
      const { app, deleted } = authorizedApp(() => new Response("Not your photo", { headers: { "x-reason": "owner" }, status: 404 }))
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/photos/1"))

      expect(response.status).toBe(404)
      expect(response.headers.get("x-reason")).toBe("owner")
      expect(await response.json()).toMatchObject({ message: "Not your photo", status: 404 })
      expect(deleted).not.toHaveBeenCalled()
    })

    it.each([
      { message: "Plan required", plan: "pro" },
      { error: "Plan required", details: { plan: "pro" } },
    ].flatMap(body => ["application/problem+json", "Application/Problem+JSON", "Application/JSON"].map(contentType => ({ body, contentType }))))("preserves custom JSON rejection fields and headers: %j", async ({ body, contentType }) => {
      const { app, deleted } = authorizedApp(() => Response.json(body, {
        headers: { "content-type": contentType, "x-reason": "plan" },
        status: 402,
      }))
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/photos/1"))

      expect(response.status).toBe(402)
      expect(response.headers.get("content-type")).toBe(contentType)
      expect(response.headers.get("x-reason")).toBe("plan")
      expect(await response.json()).toMatchObject({ ...body, message: "Plan required" })
      expect(deleted).not.toHaveBeenCalled()
    })

    it.each([{ body: ["Plan required"] }, { body: "Plan required" }, { body: 402 }, { body: false }, { body: null }])("keeps other JSON rejection values as error data: %j", async ({ body }) => {
      const { app } = authorizedApp(() => Response.json(body, { status: 402 }))
      providerMocks.getSession.mockResolvedValue(signedIn)

      const response = await app.fetch(new Request("https://example.com/photos/1"))

      expect(response.status).toBe(402)
      expect(await response.json()).toMatchObject({ data: body })
    })

    it("throws 401 without a session and never redirects to sign-in", async () => {
      const { app } = authorizedApp(true, signInDefinition)
      providerMocks.getSession.mockResolvedValue(null)

      const response = await app.fetch(new Request("https://example.com/photos/1", { headers: { accept: "text/html" } }))

      expect(response.status).toBe(401)
      expect(response.headers.get("location")).toBeNull()
      expect(await response.json()).toMatchObject({ data: { code: "SIGNED_OUT" } })
      expect(providerMocks.handler).not.toHaveBeenCalled()
    })

    it("rejects an authorize value that is not true or a function", () => {
      // SAFETY: The test deliberately violates the input contract to prove the runtime guard.
      expect(() => requireAuthorization(new Request("https://example.com/"), false as never, definition)).toThrow(expect.objectContaining({ code: "AUTH_R0014" }))
    })
  })
})
