import { apiKey } from "@better-auth/api-key"
import { memoryAdapter } from "better-auth/adapters/memory"
import { APIError, createAuthMiddleware } from "better-auth/api"
import { defineHandler, HTTPError } from "h3"
import { installStandardContext } from "@vite-hub/runtime/internal/h3"
import { afterEach, describe, expect, it } from "vitest"

import { getAuthForDefinition, handleAuthRequest, requireAuth, resetAuth, withAuth } from "../src/internal/server.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

const origin = "http://localhost:3000"

afterEach(() => {
  resetAuth()
})

function createApiKeyAuth() {
  const db: Record<string, Record<string, unknown>[]> = { account: [], apikey: [], session: [], user: [], verification: [] }
  return defineFixedAuth({
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [apiKey({ enableSessionForAPIKeys: true })],
    secret: "vitehub-api-key-refusal-test-secret-8c2f4a1e9d",
  })
}

function apiRequest(key: string): Request {
  return new Request(`${origin}/api/jobs`, { headers: { "x-api-key": key } })
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(() => undefined, (error: unknown) => error)
}

describe("requireAuth() with the API Key plugin", () => {
  it("keeps the 401 of an unknown API key", async () => {
    const error = await rejection(requireAuth(apiRequest("x".repeat(64)), createApiKeyAuth()))

    expect(error).toBeInstanceOf(HTTPError)
    expect(error).toMatchObject({ data: { code: "INVALID_API_KEY" }, status: 401 })
  })

  it("keeps the 403 of an API key that is too short", async () => {
    const error = await rejection(requireAuth(apiRequest("short"), createApiKeyAuth()))

    expect(error).toBeInstanceOf(HTTPError)
    expect(error).toMatchObject({ data: { code: "INVALID_API_KEY" }, status: 403 })
  })

  it("answers a plain Fetch guard with the 403 of an API key that is too short", async () => {
    const response = await withAuth(() => new Response("ok"), createApiKeyAuth())(apiRequest("short"))

    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(403)
    await expect((response as Response).json()).resolves.toMatchObject({ data: { code: "INVALID_API_KEY" }, status: 403 })
  })

  it("sends the headers that a Better Auth hook gives its refusal", async () => {
    const definition = defineFixedAuth({
      database: memoryAdapter({ account: [], session: [], user: [], verification: [] }),
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path !== "/get-session") return
          throw new APIError("UNAUTHORIZED", { code: "TOKEN_REVOKED", message: "Token revoked." }, {
            "set-cookie": "legacy_token=; Max-Age=0; Path=/",
            "www-authenticate": "Bearer error=\"invalid_token\"",
          })
        }),
      },
      secret: "vitehub-api-key-refusal-test-secret-8c2f4a1e9d",
    })
    const app = defineHandler(async (event) => {
      installStandardContext(event)
      const { user } = await requireAuth(event, definition)
      return { id: user.id }
    })

    const response = await app.fetch(new Request(`${origin}/api/jobs`, { headers: { accept: "application/json" } }))

    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe("Bearer error=\"invalid_token\"")
    expect(response.headers.getSetCookie()).toContain("legacy_token=; Max-Age=0; Path=/")
    await expect(response.json()).resolves.toMatchObject({ data: { code: "TOKEN_REVOKED" } })
  })

  it("accepts a valid API key", async () => {
    const definition = createApiKeyAuth()
    const signUp = await handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }))
    const { user } = await signUp.json() as { user: { id: string } }
    // SAFETY: the API Key plugin adds createApiKey() to the Better Auth API of this Definition.
    const auth = getAuthForDefinition(definition) as unknown as { api: { createApiKey: (input: { body: { userId: string } }) => Promise<{ key: string }> } }
    const { key } = await auth.api.createApiKey({ body: { userId: user.id } })

    await expect(requireAuth(apiRequest(key), definition)).resolves.toMatchObject({ user: { id: user.id } })
  })
})
