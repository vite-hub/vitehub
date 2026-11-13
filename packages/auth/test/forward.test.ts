import { memoryAdapter } from "better-auth/adapters/memory"
import { describe, expect, it, vi } from "vitest"

import { forwardAuth } from "../src/forward.ts"
import { handleAuthRequest, withAuth } from "../src/internal/server.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

import type { ForwardAuthOptions, ForwardedIdentity } from "../src/forward.ts"
import type { AuthDefinition } from "../src/index.ts"

const origin = "http://localhost:3000"
const secret = "vitehub-forward-auth-test-secret-8e3f1a6c2d"
const header = "x-auth-request-access-token"

interface MemoryRow { [key: string]: unknown }

const ada: ForwardedIdentity = { providerId: "github", accountId: "1", email: "ada@example.com", name: "Ada", emailVerified: true, accessToken: "gho_ada" }
const grace: ForwardedIdentity = { providerId: "github", accountId: "2", email: "grace@example.com", name: "Grace", emailVerified: true, accessToken: "gho_grace" }
// What the provider says about each token. A token that is not here is forged.
const tokens: Record<string, ForwardedIdentity> = { gho_ada: ada, gho_grace: grace }

function createForwardAuth(verify: ForwardAuthOptions["verify"] = ({ value }) => tokens[value] ?? null, options: Record<string, unknown> = {}) {
  const db: Record<string, MemoryRow[]> = { account: [], session: [], user: [], verification: [] }
  const definition = defineFixedAuth({
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [forwardAuth({ header, verify })],
    secret,
    ...options,
  })
  return { db, definition }
}

function cookiePairs(response: Response): string {
  return response.headers.getSetCookie()
    .map(cookie => cookie.split(";")[0])
    .filter(pair => !pair?.endsWith("="))
    .join("; ")
}

function getSession(definition: AuthDefinition, headers: Record<string, string>): Promise<Response> {
  return handleAuthRequest(definition, new Request(`${origin}/api/auth/get-session`, { headers }))
}

function guarded(definition: AuthDefinition) {
  const handler = vi.fn(() => new Response("ok"))
  const check = withAuth(handler, definition)
  return { check: (headers: Record<string, string>) => check(new Request(`${origin}/private`, { headers: { accept: "application/json", ...headers } })), handler }
}

describe("forwardAuth()", () => {
  it("never trusts the header without `verify`", () => {
    // @ts-expect-error verify is required.
    expect(() => forwardAuth({ header })).toThrow(expect.objectContaining({ code: "AUTH_C0067" }))
    // @ts-expect-error header is required.
    expect(() => forwardAuth({ verify: () => null })).toThrow(expect.objectContaining({ code: "AUTH_C0067" }))
  })

  it("refuses a forged header that `verify` does not prove", async () => {
    const verify = vi.fn(({ value }: { value: string }) => tokens[value] ?? null)
    const { db, definition } = createForwardAuth(verify)
    const { check, handler } = guarded(definition)

    const response = await getSession(definition, { [header]: "forged" })

    expect(await response.json()).toBeNull()
    expect(cookiePairs(response)).not.toContain("session_token")
    expect((await check({ [header]: "forged" })).status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ value: "forged" }))
    expect(db.user).toHaveLength(0)
    expect(db.session).toHaveLength(0)
  })

  it("signs a proven identity in, and the same request sees the session", async () => {
    const { db, definition } = createForwardAuth()

    const response = await getSession(definition, { [header]: "gho_ada" })

    expect(await response.json()).toMatchObject({ user: { email: "ada@example.com", name: "Ada", emailVerified: true } })
    expect(cookiePairs(response)).toContain("better-auth.session_token=")
    expect(db.account).toEqual([expect.objectContaining({ providerId: "github", accountId: "1", accessToken: "gho_ada" })])
    expect(db.session).toHaveLength(1)
  })

  it("reuses the session of the cookie, and of this process before the browser has the cookie", async () => {
    const { db, definition } = createForwardAuth()
    const { check, handler } = guarded(definition)

    // Server code reads the session first, so the browser does not get the cookie from these responses.
    expect((await check({ [header]: "gho_ada" })).status).toBe(200)
    expect((await check({ [header]: "gho_ada" })).status).toBe(200)
    const cookie = cookiePairs(await getSession(definition, { [header]: "gho_ada" }))
    expect(await (await getSession(definition, { [header]: "gho_ada", cookie })).json()).toMatchObject({ user: { email: "ada@example.com" } })

    expect(handler).toHaveBeenCalledTimes(2)
    expect(db.session).toHaveLength(1)
  })

  it("signs parallel first requests of one identity in once", async () => {
    const { db, definition } = createForwardAuth(async ({ value }) => tokens[value] ?? null)

    const responses = await Promise.all([1, 2, 3].map(() => getSession(definition, { [header]: "gho_ada" })))

    for (const response of responses) expect(await response.json()).toMatchObject({ user: { email: "ada@example.com" } })
    expect(db.user).toHaveLength(1)
    expect(db.session).toHaveLength(1)
  })

  it("gives another identity its own session, also when the cookie has someone else's", async () => {
    const { db, definition } = createForwardAuth()
    const cookie = cookiePairs(await getSession(definition, { [header]: "gho_ada" }))

    const response = await getSession(definition, { [header]: "gho_grace", cookie })

    expect(await response.json()).toMatchObject({ user: { email: "grace@example.com" } })
    expect(db.user).toHaveLength(2)
    expect(db.session).toHaveLength(2)
  })

  it("keeps the session of the cookie when the header is forged", async () => {
    const { definition } = createForwardAuth()
    const cookie = cookiePairs(await getSession(definition, { [header]: "gho_ada" }))

    expect(await (await getSession(definition, { [header]: "forged", cookie })).json()).toMatchObject({ user: { email: "ada@example.com" } })
  })

  it("stays signed out when Better Auth refuses the sign-in", async () => {
    const { db, definition } = createForwardAuth(undefined, {
      databaseHooks: { session: { create: { before: async () => false } } },
    })
    const { check } = guarded(definition)

    expect(await (await getSession(definition, { [header]: "gho_ada" })).json()).toBeNull()
    expect((await check({ [header]: "gho_ada" })).status).toBe(401)
    expect(db.session).toHaveLength(0)
  })

  it("does not link an existing user by an email that the identity does not prove", async () => {
    const { db, definition } = createForwardAuth(({ value }) => value === "gho_unverified" ? { ...ada, emailVerified: false } : null)
    const signUp = await handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }))
    expect(signUp.status).toBe(200)

    expect(await (await getSession(definition, { [header]: "gho_unverified" })).json()).toBeNull()
    expect(db.account!.map(account => account.providerId)).toEqual(["credential"])
  })

  it("fails the request when `verify` returns a value that is not an identity", async () => {
    const { definition } = createForwardAuth(() => ({ providerId: "github" }) as unknown as ForwardedIdentity)

    const response = await getSession(definition, { [header]: "gho_ada" })

    expect(response.status).toBe(500)
  })
})
