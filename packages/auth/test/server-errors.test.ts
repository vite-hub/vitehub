import { beforeEach, describe, expect, it, vi } from "vitest"

import { AuthenticationProviderError } from "../src/agent.ts"
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
    ["missing API", { api: {} }],
    ["malformed response", { api: { getSession: () => ({ session: {}, user: {} }) } }],
  ])("maps a %s from requireAuth", async (_case, auth) => {
    providerMocks.betterAuth.mockReturnValueOnce(auth)

    await expect(requireAuth(request, definition)).rejects.toMatchObject({
      code: "AUTH_PROVIDER_OPERATION_FAILED",
      details: { operation: "get-session", provider: "better-auth" },
      name: "AuthenticationProviderError",
    })
  })

  it("maps Auth construction failures with the owning operation", async () => {
    const cause = new Error("protected provider configuration")
    providerMocks.betterAuth.mockImplementationOnce(() => { throw cause })

    const error = await requireAuth(request, definition).catch(error => error)

    expect(error).toBeInstanceOf(AuthenticationProviderError)
    expect(error).toMatchObject({
      cause,
      details: { operation: "get-auth-for-request", provider: "better-auth" },
    })
  })

  it("preserves abort and existing provider errors exactly", async () => {
    const abort = new DOMException("cancelled", "AbortError")
    providerMocks.getSession.mockRejectedValueOnce(abort)
    await expect(requireAuth(request, definition)).rejects.toBe(abort)

    const providerError = new AuthenticationProviderError({ operation: "get-session" })
    providerMocks.getSession.mockRejectedValueOnce(providerError)
    await expect(requireAuth(request, definition)).rejects.toBe(providerError)
  })

  it("keeps handleAuthRequest as the exact Better Auth passthrough", async () => {
    const providerError = new Error("raw handler failure")
    providerMocks.handler.mockRejectedValueOnce(providerError)

    await expect(handleAuthRequest(definition, request)).rejects.toBe(providerError)
  })
})
