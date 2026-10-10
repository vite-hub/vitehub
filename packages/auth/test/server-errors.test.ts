import { beforeEach, describe, expect, it, vi } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { defineAuth } from "../src/index.ts"
import { handleAuthRequest, requireAuthAccessRoutes, withAuth, withAuthorization } from "../src/server.ts"

import type { AuthAuthorization } from "../src/index.ts"

const providerMocks = vi.hoisted(() => ({
  betterAuth: vi.fn(),
  getSession: vi.fn(),
  handler: vi.fn(),
}))

vi.mock("better-auth", () => ({
  betterAuth: providerMocks.betterAuth,
}))

const definition = defineAuth({ appName: "ViteHub" })
const request = new Request("https://example.com/api/private")
const protectedAction = vi.fn((_input: unknown, _authorization: AuthAuthorization) => "protected")

describe("server authentication provider boundaries", () => {
  beforeEach(() => {
    providerMocks.betterAuth.mockReset()
    providerMocks.getSession.mockReset()
    providerMocks.handler.mockReset()
    protectedAction.mockClear()
    providerMocks.betterAuth.mockReturnValue({
      api: { getSession: providerMocks.getSession },
      handler: providerMocks.handler,
    })
  })

  it.each([
    ["missing API", { api: {} }, "AUTH_R0011", "Better Auth did not expose api.getSession()."],
    ["malformed response", { api: { getSession: () => ({ session: {}, user: {} }) } }, "AUTH_R0012", "Better Auth returned an invalid session response."],
  ])("preserves ViteHub's %s validation", async (_case, auth, code, message) => {
    providerMocks.betterAuth.mockReturnValueOnce(auth)

    await expect(withAuth(protectedAction, definition)(request)).rejects.toMatchObject({ code, message })
  })

  it.each([
    new Error("protected provider configuration"),
    new TypeError("fetch failed"),
  ])("maps Auth construction failures with the owning operation", async (cause) => {
    providerMocks.betterAuth.mockImplementationOnce(() => {
      throw cause
    })

    const error = await withAuth(protectedAction, definition)(request).catch(error => error)

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({
      cause,
      details: { operation: "get-auth-for-request", provider: "better-auth" },
    })
  })

  it("preserves ViteHub configuration TypeErrors exactly", async () => {
    const configurationError = new TypeError("invalid request configuration")
    const invalidDefinition = defineAuth(() => {
      throw configurationError
    })

    await expect(withAuth(protectedAction, invalidDefinition)(request)).rejects.toBe(configurationError)
  })

  it("normalizes operational session TypeErrors with their exact cause", async () => {
    const cause = new TypeError("fetch failed")
    providerMocks.getSession.mockRejectedValueOnce(cause)

    const error = await withAuth(protectedAction, definition)(request).catch(error => error)

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({
      cause,
      details: { operation: "get-session", provider: "better-auth" },
    })
  })

  it.each([
    ["auth.api", (cause: Error) => Object.defineProperty({}, "api", {
      get() {
        throw cause
      },
    })],
    ["session.user", (cause: Error) => ({
      api: {
        getSession: () => Object.defineProperty({ session: {} }, "user", {
          get() {
            throw cause
          },
        }),
      },
    })],
  ] as const)("normalizes a throwing %s provider getter with its exact cause", async (_property, createAuth) => {
    const cause = new TypeError("provider getter failed")
    providerMocks.betterAuth.mockReturnValueOnce(createAuth(cause))

    const error = await withAuth(protectedAction, definition)(request).catch(error => error)

    expect(error).toBeInstanceOf(ViteHubError)
    expect(error).toMatchObject({
      code: "AUTH_PROVIDER_OPERATION_FAILED",
      details: { operation: "get-session", provider: "better-auth" },
    })
    expect(error.cause).toBe(cause)
  })

  it("preserves abort and existing provider errors exactly", async () => {
    const abort = new DOMException("cancelled", "AbortError")
    providerMocks.getSession.mockRejectedValueOnce(abort)
    await expect(withAuth(protectedAction, definition)(request)).rejects.toBe(abort)

    const providerError = new ViteHubError("AUTH_PROVIDER_OPERATION_FAILED", "Custom provider failure.")
    providerMocks.getSession.mockRejectedValueOnce(providerError)
    await expect(withAuth(protectedAction, definition)(request)).rejects.toBe(providerError)
  })

  it("keeps handleAuthRequest as the exact Better Auth passthrough", async () => {
    const providerError = new Error("raw handler failure")
    providerMocks.handler.mockRejectedValueOnce(providerError)

    await expect(handleAuthRequest(definition, request)).rejects.toBe(providerError)
  })

  it("does not unwrap an inherited host request property", async () => {
    let origin = ""
    const requestDefinition = defineAuth(({ requestOrigin }) => {
      origin = requestOrigin
      return {
        baseURL: requestOrigin,
        secret: "abcdefghijklmnopqrstuvwxyz0123456789",
      }
    })
    providerMocks.getSession.mockResolvedValue(null)

    const input = Object.assign(Object.create({
      req: new Request("https://attacker.example/api/private"),
    }), {
      body: null,
      headers: new Headers(),
      method: "GET",
      signal: undefined,
      url: "https://example.com/api/private",
    })

    await expect(withAuth(protectedAction, requestDefinition)(input as never)).resolves.toMatchObject({ status: 401 })
    expect(origin).toBe("https://example.com")
  })

  it.each(["definition", "runtime"] as const)("resolves the %s callback once for an Auth request", async (kind) => {
    const resolve = vi.fn(() => ({
      baseURL: "https://example.com",
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
    }))
    const requestDefinition = kind === "definition" ? defineAuth(resolve) : defineAuth({ runtime: resolve })
    const response = new Response("ok")
    providerMocks.handler.mockResolvedValue(response)

    await expect(handleAuthRequest(requestDefinition, request)).resolves.toBe(response)

    expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ request }))
    expect(providerMocks.betterAuth).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://example.com",
      secret: "abcdefghijklmnopqrstuvwxyz0123456789",
      trustedOrigins: ["https://example.com"],
    }))
  })

  it("authorizes with the same configuration snapshot that authenticated the request", async () => {
    let allowAccess = false
    const resolve = vi.fn(() => {
      const allowed = allowAccess
      return {
        access: { routes: [{ authorize: () => allowed, route: "/api/private" }] },
        secret: "abcdefghijklmnopqrstuvwxyz0123456789",
      }
    })
    providerMocks.getSession.mockImplementation(async () => {
      allowAccess = true
      return { session: { id: "session-1" }, user: { id: "user-1" } }
    })

    const requestDefinition = defineAuth(resolve)
    const response = await requireAuthAccessRoutes(request, [0], requestDefinition, [0])

    expect(response?.status).toBe(403)
    expect(resolve).toHaveBeenCalledOnce()

    await expect(requireAuthAccessRoutes(request, [0], requestDefinition, [0])).resolves.toBeUndefined()
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it("runs route authorization with the authenticated request context", async () => {
    let allowed = true
    const authorize = vi.fn(({ request, session, user }) => {
      expect(request.url).toBe("https://example.com/api/private")
      expect(session).toEqual({ id: "session-1" })
      expect(user).toEqual({ id: "user-1", isAdmin: true })
      return allowed
    })
    const accessDefinition = defineAuth({
      access: {
        routes: [{ authorize, route: "/api/private" }],
      },
      appName: "ViteHub",
    })
    providerMocks.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1", isAdmin: true },
    })

    await expect(requireAuthAccessRoutes(request, [0], accessDefinition)).resolves.toBeUndefined()

    allowed = false
    const forbidden = await requireAuthAccessRoutes(request, [0], accessDefinition)
    expect(forbidden?.status).toBe(403)
    expect(await forbidden?.json()).toEqual({ error: "Forbidden." })
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it("fails closed when a required route authorization callback is absent at runtime", async () => {
    const accessDefinition = defineAuth({
      access: { routes: [{ authorize: undefined, route: "/api/private" }] },
      appName: "ViteHub",
    })
    providerMocks.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1" },
    })

    const forbidden = await requireAuthAccessRoutes(request, [0], accessDefinition, [0])

    expect(forbidden?.status).toBe(403)
    expect(await forbidden?.json()).toEqual({ error: "Forbidden." })
  })

  it("passes through custom route authorization responses", async () => {
    const denied = new Response("Admin access required", { status: 403 })
    const accessDefinition = defineAuth({
      access: {
        routes: [{ authorize: () => denied, route: "/api/private" }],
      },
      appName: "ViteHub",
    })
    providerMocks.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1" },
    })

    await expect(requireAuthAccessRoutes(request, [0], accessDefinition)).resolves.toBe(denied)
  })

  describe("withAuthorization", () => {
    const imageRequest = new Request("https://example.com/photos/user-1/meal.jpg", {
      headers: { accept: "text/html,image/avif,image/webp,*/*" },
    })

    it("returns JSON 401 without a session and never redirects to sign-in", async () => {
      const authorize = vi.fn(() => true)
      const signInDefinition = defineAuth({ access: { signIn: { provider: "github" } }, appName: "ViteHub" })
      providerMocks.getSession.mockResolvedValue(null)

      const response = await withAuthorization(authorize, protectedAction, signInDefinition)({ req: imageRequest })

      expect(response).toBeInstanceOf(Response)
      if (!(response instanceof Response)) return
      expect(response.status).toBe(401)
      expect(response.headers.get("location")).toBeNull()
      expect(await response.json()).toEqual({ error: "Unauthorized." })
      expect(authorize).not.toHaveBeenCalled()
      expect(protectedAction).not.toHaveBeenCalled()
    })

    it("runs the handler with the checked authorization for true", async () => {
      providerMocks.getSession.mockResolvedValue({ session: { id: "session-1" }, user: { id: "user-1" } })

      await expect(withAuthorization(true, protectedAction, definition)(request)).resolves.toBe("protected")
      const authorization = protectedAction.mock.calls[0]?.[1]
      expect(authorization).toEqual({ request, session: { id: "session-1" }, user: { id: "user-1" } })
      expect(Object.isFrozen(authorization)).toBe(true)
    })

    it("runs the callback with the request, session, and user before the handler", async () => {
      const authorize = vi.fn(({ request, user }: { request: Pick<Request, "url">, user: { id: string } }) =>
        new URL(request.url).pathname.startsWith(`/photos/${user.id}/`))
      const guarded = withAuthorization(authorize, protectedAction, definition)
      providerMocks.getSession.mockResolvedValue({ session: { id: "session-1" }, user: { id: "user-1" } })

      await expect(guarded(imageRequest)).resolves.toBe("protected")
      expect(authorize).toHaveBeenCalledWith({
        request: imageRequest,
        session: { id: "session-1" },
        user: { id: "user-1" },
      })

      providerMocks.getSession.mockResolvedValue({ session: { id: "session-2" }, user: { id: "user-2" } })
      const forbidden = await guarded(request)
      expect(forbidden).toBeInstanceOf(Response)
      if (!(forbidden instanceof Response)) return
      expect(forbidden.status).toBe(403)
      expect(await forbidden.json()).toEqual({ error: "Forbidden." })
      expect(protectedAction).toHaveBeenCalledOnce()
    })

    it("returns a custom callback response as-is", async () => {
      const denied = new Response("Not your photo", { status: 404 })
      providerMocks.getSession.mockResolvedValue({ session: { id: "session-1" }, user: { id: "user-1" } })

      await expect(withAuthorization(() => denied, protectedAction, definition)(request)).resolves.toBe(denied)
      expect(protectedAction).not.toHaveBeenCalled()
    })

    it("ignores a forged authorization from the caller", async () => {
      const forged: AuthAuthorization = { request, session: { id: "forged" }, user: { id: "admin" } }
      const guarded = withAuthorization(true, protectedAction, definition)
      providerMocks.getSession.mockResolvedValue(null)

      // SAFETY: The test deliberately passes an extra argument to prove the guard ignores it at runtime.
      const response = await Reflect.apply(guarded, undefined, [request, forged])
      expect(response).toMatchObject({ status: 401 })
      expect(protectedAction).not.toHaveBeenCalled()

      providerMocks.getSession.mockResolvedValue({ session: { id: "session-1" }, user: { id: "user-1" } })
      await Reflect.apply(guarded, undefined, [request, forged])
      expect(protectedAction.mock.calls[0]?.[1]).not.toBe(forged)
      expect(protectedAction.mock.calls[0]?.[1]).toMatchObject({ user: { id: "user-1" } })
    })

    it("rejects an authorize value that is not true or a function when it wraps the handler", () => {
      // SAFETY: The test deliberately violates the input contract to prove the runtime guard.
      expect(() => withAuthorization(false as never, protectedAction, definition)).toThrow(expect.objectContaining({ code: "AUTH_R0014" }))
      expect(providerMocks.getSession).not.toHaveBeenCalled()
    })

    it("rejects a missing handler", () => {
      // SAFETY: The test deliberately violates the input contract to prove the runtime guard.
      expect(() => withAuthorization(true, undefined as never, definition)).toThrow(expect.objectContaining({ code: "AUTH_R0015" }))
      expect(() => withAuth(undefined as never, definition)).toThrow(expect.objectContaining({ code: "AUTH_R0015" }))
    })
  })

  it("requires authorization from every matching access route", async () => {
    const authorizeAdmin = vi.fn(() => false)
    const accessDefinition = defineAuth({
      access: {
        routes: [
          "/api/**",
          { authorize: authorizeAdmin, route: "/api/private" },
        ],
      },
      appName: "ViteHub",
    })
    providerMocks.getSession.mockResolvedValue({
      session: { id: "session-1" },
      user: { id: "user-1", isAdmin: false },
    })

    const forbidden = await requireAuthAccessRoutes(request, [0, 1], accessDefinition)

    expect(forbidden?.status).toBe(403)
    expect(authorizeAdmin).toHaveBeenCalledOnce()
  })
})
