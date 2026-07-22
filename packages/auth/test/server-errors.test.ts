import { beforeEach, describe, expect, it, vi } from "vitest"
import { ViteHubError } from "@vite-hub/runtime"

import { defineAuth } from "../src/index.ts"
import { handleAuthRequest, requireAuth } from "../src/server.ts"

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

describe("server authentication provider boundaries", () => {
  beforeEach(() => {
    providerMocks.betterAuth.mockReset()
    providerMocks.getSession.mockReset()
    providerMocks.handler.mockReset()
    providerMocks.betterAuth.mockReturnValue({
      api: { getSession: providerMocks.getSession },
      handler: providerMocks.handler,
    })
  })

  it.each([
    ["missing API", { api: {} }, "Better Auth did not expose api.getSession()."],
    ["malformed response", { api: { getSession: () => ({ session: {}, user: {} }) } }, "Better Auth returned an invalid session response."],
  ])("preserves ViteHub's %s validation", async (_case, auth, message) => {
    providerMocks.betterAuth.mockReturnValueOnce(auth)

    await expect(requireAuth(request, definition)).rejects.toEqual(new TypeError(message))
  })

  it.each([
    new Error("protected provider configuration"),
    new TypeError("fetch failed"),
  ])("maps Auth construction failures with the owning operation", async (cause) => {
    providerMocks.betterAuth.mockImplementationOnce(() => {
      throw cause
    })

    const error = await requireAuth(request, definition).catch(error => error)

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

    await expect(requireAuth(request, invalidDefinition)).rejects.toBe(configurationError)
  })

  it("normalizes operational session TypeErrors with their exact cause", async () => {
    const cause = new TypeError("fetch failed")
    providerMocks.getSession.mockRejectedValueOnce(cause)

    const error = await requireAuth(request, definition).catch(error => error)

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

    const error = await requireAuth(request, definition).catch(error => error)

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
    await expect(requireAuth(request, definition)).rejects.toBe(abort)

    const providerError = new ViteHubError("AUTH_PROVIDER_OPERATION_FAILED", "Custom provider failure.")
    providerMocks.getSession.mockRejectedValueOnce(providerError)
    await expect(requireAuth(request, definition)).rejects.toBe(providerError)
  })

  it("keeps handleAuthRequest as the exact Better Auth passthrough", async () => {
    const providerError = new Error("raw handler failure")
    providerMocks.handler.mockRejectedValueOnce(providerError)

    await expect(handleAuthRequest(definition, request)).rejects.toBe(providerError)
  })
})
