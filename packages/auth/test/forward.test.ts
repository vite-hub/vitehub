import { APIError } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { describe, expect, it, vi } from "vitest"

import { forwardAuth } from "../src/forward.ts"
import { handleAuthRequest, withAuth } from "../src/internal/server.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

import type { ForwardAuthOptions, ForwardAuthRefusal, ForwardedIdentity } from "../src/forward.ts"
import type { AuthDefinition, AuthEvent, AuthEventStore } from "../src/index.ts"

const origin = "http://localhost:3000"
const secret = "vitehub-forward-auth-test-secret-8e3f1a6c2d"
const header = "x-auth-request-access-token"

interface MemoryRow { [key: string]: unknown }

const ada: ForwardedIdentity = { providerId: "github", accountId: "1", email: "ada@example.com", name: "Ada", emailVerified: true, accessToken: "gho_ada" }
const grace: ForwardedIdentity = { providerId: "github", accountId: "2", email: "grace@example.com", name: "Grace", emailVerified: true, accessToken: "gho_grace" }
// What the provider says about each token. A token that is not here is forged.
const tokens: Record<string, ForwardedIdentity> = { gho_ada: ada, gho_grace: grace }

function createForwardAuth(verify: ForwardAuthOptions["verify"] = ({ value }) => tokens[value] ?? null, options: Record<string, unknown> = {}, onRefused?: ForwardAuthOptions["onRefused"]) {
  const db: Record<string, MemoryRow[]> = { account: [], session: [], user: [], verification: [] }
  const events: AuthEvent[] = []
  const store: AuthEventStore = {
    append: async (event) => { events.push(event) },
    list: async () => ({ events }),
    aggregate: async () => ({ days: [], totals: { activeUsers: 0, methods: {}, signIns: 0, signUps: 0 } }),
  }
  const definition = defineFixedAuth({
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    events: { store },
    plugins: [forwardAuth({ header, verify, ...(onRefused ? { onRefused } : {}) })],
    secret,
    ...options,
  })
  return { db, definition, events }
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

function post(definition: AuthDefinition, path: string, body: object, headers: Record<string, string> = {}): Promise<Response> {
  return handleAuthRequest(definition, new Request(`${origin}/api/auth/${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, ...headers },
    method: "POST",
  }))
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

  it("records one sign-in and one sign-up with method `forward`", async () => {
    const { definition, events } = createForwardAuth()
    const { check } = guarded(definition)

    expect((await check({ [header]: "gho_ada" })).status).toBe(200)
    const cookie = cookiePairs(await getSession(definition, { [header]: "gho_ada" }))
    await getSession(definition, { [header]: "gho_ada", cookie })

    expect(events.filter(event => event.type === "user.signed_in")).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ method: "forward" }) })])
    expect(events.filter(event => event.type === "user.signed_up")).toEqual([expect.objectContaining({ metadata: { method: "forward" } })])
  })

  it("records a forward sign-in through Better Auth's own request, too", async () => {
    const { definition, events } = createForwardAuth()

    await getSession(definition, { [header]: "gho_ada" })

    expect(events.filter(event => event.type === "user.signed_in").map(event => event.metadata.method)).toEqual(["forward"])
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

  it.each(["expired", "deleted"])("replaces a %s session despite its retained cookie", async (state) => {
    const { db, definition } = createForwardAuth()
    const first = await getSession(definition, { [header]: "gho_ada" })
    const cookie = cookiePairs(first)
    const original = db.session![0]!.token
    if (state === "expired") db.session![0]!.expiresAt = new Date(0)
    else db.session!.splice(0)

    const response = await getSession(definition, { [header]: "gho_ada", cookie })
    expect(await response.json()).toMatchObject({ user: { email: ada.email } })
    expect(db.session!.some(session => session.token !== original)).toBe(true)
  })

  it.each([false, true])("refuses an identity switch with cookie cache %s", async (enabled) => {
    let refuse = false
    const { definition } = createForwardAuth(undefined, {
      session: { cookieCache: { enabled } },
      databaseHooks: { session: { create: { before: async () => refuse ? false : undefined } } },
    })
    const cookie = cookiePairs(await getSession(definition, { [header]: "gho_ada" }))
    refuse = true
    expect(await (await getSession(definition, { [header]: "gho_grace", cookie })).json()).toBeNull()
    expect((await guarded(definition).check({ [header]: "gho_grace", cookie })).status).toBe(401)
  })

  it.each([false, true])("refreshes credentials during reuse with cookie %s", async (withCookie) => {
    const { db, definition } = createForwardAuth(({ value }) => ({ ...ada, accessToken: value }))
    const cookie = cookiePairs(await getSession(definition, { [header]: "old-token" }))
    await getSession(definition, { [header]: "new-token", ...(withCookie ? { cookie } : {}) })
    expect(db.account![0]!.accessToken).toBe("new-token")
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

  it("tells `onRefused` why Better Auth refused a proven identity", async () => {
    const refusals: ForwardAuthRefusal[] = []
    const { definition, events } = createForwardAuth(({ value }) => value === "gho_unverified" ? { ...ada, emailVerified: false } : null, {}, (refusal) => { refusals.push(refusal) })
    await handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-up/email`, {
      body: JSON.stringify({ email: "ada@example.com", name: "Ada", password: "passwordpassword" }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }))

    expect(await (await getSession(definition, { [header]: "gho_unverified" })).json()).toBeNull()

    expect(refusals).toEqual([expect.objectContaining({ code: "account_not_linked", identity: expect.objectContaining({ providerId: "github", accountId: "1" }) })])
    expect(refusals[0]?.request).toBeInstanceOf(Request)
    expect(events.filter(event => event.type === "user.signed_in")).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ method: "email-password" }) })])
  })

  it("names a refused session in `onRefused`", async () => {
    const onRefused = vi.fn()
    const { definition } = createForwardAuth(undefined, { databaseHooks: { session: { create: { before: async () => false } } } }, onRefused)

    await getSession(definition, { [header]: "gho_ada" })

    expect(onRefused).toHaveBeenCalledWith(expect.objectContaining({ code: "unable_to_create_session" }))
  })

  it("keeps the method of a password sign-in and an email sign-up on a request that `forwardAuth()` handles", async () => {
    const refused = createForwardAuth(({ value }) => value === "gho_unverified" ? { ...ada, emailVerified: false } : null)
    expect((await post(refused.definition, "sign-up/email", { email: ada.email, name: "Ada", password: "passwordpassword" })).status).toBe(200)
    refused.events.splice(0)

    expect((await post(refused.definition, "sign-in/email", { email: ada.email, password: "passwordpassword" }, { [header]: "gho_unverified" })).status).toBe(200)
    expect((await post(refused.definition, "sign-in/email", { email: ada.email, password: "wrong-password" }, { [header]: "gho_unverified" })).status).toBe(401)

    expect(refused.events.map(event => [event.type, event.metadata.method])).toEqual([["user.signed_in", "email-password"], ["sign_in.failed", "email-password"]])

    const accepted = createForwardAuth()
    expect((await post(accepted.definition, "sign-up/email", { email: "eve@example.com", name: "Eve", password: "passwordpassword" }, { [header]: "gho_grace" })).status).toBe(200)

    const signUps = accepted.events.filter(event => event.type === "user.signed_up")
    const userIds = Object.fromEntries((accepted.db.user ?? []).map(user => [String(user.email), user.id]))
    expect(signUps.map(event => [event.userId, event.metadata.method])).toEqual(expect.arrayContaining([[userIds["grace@example.com"], "forward"], [userIds["eve@example.com"], "email-password"]]))
    expect(signUps).toHaveLength(2)
  })

  it("tells `onRefused` when a provider requires a verified email", async () => {
    const onRefused = vi.fn()
    const { definition } = createForwardAuth(({ value }) => value === "gho_grace" ? { ...grace, emailVerified: false } : null, {
      socialProviders: { github: { clientId: "github-client", clientSecret: "github-secret", requireEmailVerification: true } },
    }, onRefused)

    expect(await (await getSession(definition, { [header]: "gho_grace" })).json()).toBeNull()

    expect(onRefused).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "email_not_verified" }))
  })

  it("tells `onRefused` about a denial that Better Auth throws, and keeps its response", async () => {
    const validated = vi.fn()
    const byValidation = createForwardAuth(undefined, { user: { validateUserInfo: () => ({ error: "blocked_domain" }) } }, validated)
    const hooked = vi.fn()
    const byHook = createForwardAuth(undefined, { databaseHooks: { session: { create: { before: async () => {
      throw new APIError("FORBIDDEN", { message: "Sessions are closed." })
    } } } } }, hooked)

    expect((await getSession(byValidation.definition, { [header]: "gho_ada" })).status).toBe(403)
    expect((await getSession(byHook.definition, { [header]: "gho_ada" })).status).toBe(403)

    expect(validated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "denied", error: expect.objectContaining({ body: expect.objectContaining({ code: "blocked_domain" }) }) }))
    expect(hooked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "denied", identity: expect.objectContaining({ accountId: "1" }) }))
  })

  it("does not call `onRefused` for a server error", async () => {
    const onRefused = vi.fn()
    const { definition } = createForwardAuth(undefined, { databaseHooks: { session: { create: { before: async () => {
      throw new Error("The database is down.")
    } } } } }, onRefused)

    expect((await getSession(definition, { [header]: "gho_ada" })).status).toBe(500)
    expect(onRefused).not.toHaveBeenCalled()
  })

  it("fails the request when `verify` returns a value that is not an identity", async () => {
    const { definition } = createForwardAuth(() => ({ providerId: "github" }) as unknown as ForwardedIdentity)

    const response = await getSession(definition, { [header]: "gho_ada" })

    expect(response.status).toBe(500)
  })
})
