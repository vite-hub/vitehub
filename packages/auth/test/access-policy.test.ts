import { bearer } from "better-auth/plugins"
import { memoryAdapter } from "better-auth/adapters/memory"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defineAuth } from "../src/index.ts"
import { createAuth, handleAuthRequest, withAuth } from "../src/internal/server.ts"
import { stateless } from "../src/presets.ts"
import { defineFixedAuth } from "./fixed-auth.ts"

import type { AuthAccessPolicy, AuthAccessPolicyContext, AuthDefinition } from "../src/index.ts"

const origin = "http://localhost:3000"
const secret = "vitehub-access-policy-test-secret-4d1c9b7e2a"

interface MemoryRow { [key: string]: unknown }

function createPolicyAuth(allow: AuthAccessPolicy["allow"], recheck?: number, cookieCache = false, bearerAuth = false) {
  const db: Record<string, MemoryRow[]> = { account: [], session: [], user: [], verification: [] }
  const definition = defineFixedAuth({
    access: { policy: { allow, ...(recheck === undefined ? {} : { recheck }) } },
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    secret,
    plugins: bearerAuth ? [bearer()] : [],
    ...(cookieCache ? { session: { cookieCache: { enabled: true, maxAge: 300 } } } : {}),
  })
  return { db, definition }
}

function cookieHeader(response: Response): string {
  return response.headers.getSetCookie()
    .map(cookie => cookie.split(";")[0])
    .filter(pair => !pair?.endsWith("="))
    .join("; ")
}

function signUp(definition: AuthDefinition, email = "ada@example.com"): Promise<Response> {
  return handleAuthRequest(definition, new Request(`${origin}/api/auth/sign-up/email`, {
    body: JSON.stringify({ email, name: "Ada", password: "passwordpassword" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }))
}

function getSession(definition: AuthDefinition, cookie: string): Promise<Response> {
  return handleAuthRequest(definition, new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }))
}

afterEach(() => {
  vi.useRealTimers()
})

describe("access.policy", () => {
  it("refuses a sign-in that `allow` refuses, and creates no session", async () => {
    const allow = vi.fn(({ user }: AuthAccessPolicyContext) => user.email !== "eve@example.com")
    const { db, definition } = createPolicyAuth(allow)

    expect((await signUp(definition)).status).toBe(200)
    const refused = await signUp(definition, "eve@example.com")

    expect(refused.ok).toBe(false)
    expect(cookieHeader(refused)).not.toContain("session_token")
    expect(db.session!.map(session => session.userId)).toEqual([db.user!.find(user => user.email === "ada@example.com")!.id])
    expect(allow).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ email: "eve@example.com" }) }))
  })

  it.each([false, true])("ends the session when a recheck refuses the user (cookie cache: %s)", async (cookieCache) => {
    let member = true
    const { db, definition } = createPolicyAuth(() => member, 0, cookieCache)
    const cookie = cookieHeader(await signUp(definition))
    expect(await (await getSession(definition, cookie)).json()).toMatchObject({ user: { email: "ada@example.com" } })

    member = false
    const response = await getSession(definition, cookie)

    expect(await response.json()).toBeNull()
    expect(response.headers.getSetCookie().some(value => /^better-auth\.session_token=;.*Max-Age=0/i.test(value))).toBe(true)
    expect(db.session).toHaveLength(0)
    member = true
    expect(await (await getSession(definition, cookie)).json()).toBeNull()
  })

  it("answers 401 from the ViteHub guards once the policy refuses the user", async () => {
    let member = true
    const { db, definition } = createPolicyAuth(() => member, 0)
    const cookie = cookieHeader(await signUp(definition))
    const handler = vi.fn(() => new Response("ok"))
    const guarded = withAuth(handler, definition)
    const request = () => new Request(`${origin}/private`, { headers: { accept: "application/json", cookie } })
    expect((await guarded(request())).status).toBe(200)

    member = false

    expect((await guarded(request())).status).toBe(401)
    expect(handler).toHaveBeenCalledOnce()
    expect(db.session).toHaveLength(0)
  })

  it.each([
    ["session", true], ["guard", true], ["session", false], ["guard", false],
  ] as const)("revokes a refused bearer-only %s request (signed: %s)", async (kind, signed) => {
    let member = true
    const allow = vi.fn(() => member)
    const { db, definition } = createPolicyAuth(allow, 0, true, true)
    const signup = await signUp(definition)
    const token = signed ? signup.headers.get("set-auth-token")! : String(db.session![0]!.token)
    expect(token).toBeTruthy()
    const headers = { authorization: `Bearer ${token}`, accept: "application/json" }
    const handler = vi.fn(() => new Response("protected"))
    const guarded = withAuth(handler, definition)
    const request = () => kind === "session"
      ? handleAuthRequest(definition, new Request(`${origin}/api/auth/get-session`, { headers }))
      : guarded(new Request(`${origin}/private`, { headers }))
    expect((await request()).status).toBe(200)
    member = false
    const refused = await request()
    if (kind === "session") {
      expect(await refused.json()).toBeNull()
      expect(refused.headers.getSetCookie().some(value => /session_token=;.*Max-Age=0/i.test(value))).toBe(true)
    }
    else expect(refused.status).toBe(401)
    expect(allow.mock.calls.length).toBeGreaterThan(1)
    expect(db.session).toHaveLength(0)
    member = true
    const replay = await request()
    if (kind === "session") expect(await replay.json()).toBeNull()
    else expect(replay.status).toBe(401)
  })

  it("keeps an allowed answer for `recheck` milliseconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const allow = vi.fn(() => true)
    const { definition } = createPolicyAuth(allow, 60_000)
    const cookie = cookieHeader(await signUp(definition))
    expect(allow).toHaveBeenCalledOnce()

    await getSession(definition, cookie)
    await getSession(definition, cookie)
    expect(allow).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(60_001)
    await getSession(definition, cookie)
    expect(allow).toHaveBeenCalledTimes(2)
  })

  it("fails the request and keeps the session when `allow` throws", async () => {
    let fail = false
    const { db, definition } = createPolicyAuth(() => {
      if (fail) throw new Error("membership service is down")
      return true
    }, 0)
    const cookie = cookieHeader(await signUp(definition))

    fail = true
    const response = await getSession(definition, cookie)

    expect(response.status).toBe(500)
    expect(db.session).toHaveLength(1)
    fail = false
    expect(await (await getSession(definition, cookie)).json()).toMatchObject({ user: { email: "ada@example.com" } })
  })

  it("gives `allow` the access token of a provider account", async () => {
    const tokens: Array<string | null> = []
    const { db, definition } = createPolicyAuth(async ({ accessToken }) => {
      tokens.push(await accessToken("github"))
      return true
    }, 0)
    const cookie = cookieHeader(await signUp(definition))
    db.account!.push({ id: "github-account", accountId: "22072217", providerId: "github", userId: db.user![0]!.id, accessToken: "gho_member", createdAt: new Date(), updatedAt: new Date() })

    await getSession(definition, cookie)

    expect(tokens).toEqual([null, "gho_member"])
  })

  it("rejects a policy without an `allow` function or with a negative `recheck`", () => {
    // @ts-expect-error allow is required.
    expect(() => defineAuth({ access: { policy: {} } })).toThrow(expect.objectContaining({ code: "AUTH_C0065" }))
    expect(() => defineAuth({ access: { policy: { allow: () => true, recheck: -1 } } })).toThrow(expect.objectContaining({ code: "AUTH_C0065" }))
    // @ts-expect-error public takes route strings.
    expect(() => defineAuth({ access: { public: ["/", 1] } })).toThrow(expect.objectContaining({ code: "AUTH_C0064" }))
    expect(() => defineAuth({ access: { public: ["login"] } })).toThrow(expect.objectContaining({ code: "AUTH_C0064" }))
  })

  it("needs a session store, because it cannot end a session that lives only in a cookie", () => {
    const definition = defineAuth(() => ({ access: { policy: { allow: () => true } }, preset: stateless(), secret }))

    expect(() => createAuth(definition)).toThrow(expect.objectContaining({ code: "AUTH_C0066" }))
  })
})
