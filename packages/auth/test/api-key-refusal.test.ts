import { apiKey } from "@better-auth/api-key"
import { memoryAdapter } from "better-auth/adapters/memory"
import { HTTPError } from "h3"
import { afterEach, describe, expect, it } from "vitest"

import { getAuthForDefinition, handleAuthRequest, requireAuth, resetAuth } from "../src/internal/server.ts"
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
